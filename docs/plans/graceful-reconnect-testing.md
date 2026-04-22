# Graceful Disconnect / Reconnect / Mobile Sleep

> **Part of**: [Unified Transport plan](./unified-transport.md) (Steps 3-4)
>
> **Prerequisite**: Always-WebSocket transport (Steps 0-2 of the umbrella plan).
> A single connection state machine only makes sense when there's a single connection to manage.
> With two independent SSE streams, partial failure creates a 3x3 state matrix that's
> untestable and unreasonable to build a state machine around.

## Problem

Mobile users experience unpredictable behavior when resuming from sleep, backgrounding Chrome, or encountering transient network issues. Symptoms include:

- Page navigating back to login when it shouldn't
- UI going blank or showing stale state
- Scroll position lost on reconnect
- Different behavior for short sleep vs long sleep vs app background
- "Not updating" requiring manual refresh

The root cause is that reconnection logic was built reactively — each time a user reported "it's not updating," more defensive code was added. The result is multiple overlapping systems that sometimes fight each other:

### Current Architecture (5+ reconnection systems)

1. **useSSE stale detection** — 10s polling interval, 45s threshold, forces reconnect
2. **useSSE visibility handler** — if hidden >5s, forces reconnect on return
3. **ActivityBus stale detection** — independent 45s threshold, its own `forceReconnect()`
4. **SecureConnection.forceReconnect()** — tears down WebSocket, clears subscriptions, reconnects
5. **RemoteConnectionContext auto-resume** — on mount, tries to resume SRP session
6. **ConnectionGate** — redirects to /login if not connected (can fight reconnect attempts)
7. **FetchSSE auth detection** — signals `loginRequired` on 401, which triggers redirect

These systems interact in unpredictable ways. For example: page wakes from sleep -> visibility handler fires -> calls forceReconnect on SecureConnection -> clears subscriptions -> but ConnectionGate sees "not connected" state before reconnect completes -> redirects to /login -> user loses their place.

### Why Testing is Hard

- **localhost doesn't have real disconnects**: Loopback connections survive sleep, don't have TCP keepalive timeouts, and don't go through WiFi power management.
- **DevTools "offline" mode is binary**: It instantly kills all connections. Real mobile sleep is gradual — WiFi may stay connected for a while, WebSocket may survive in some cases, TCP may timeout after OS-specific intervals.
- **Real behavior is OS-dependent**: iOS and Android handle background tabs differently. iOS aggressively suspends JS after ~30s. Android varies by manufacturer.
- **No test seams**: The reconnection logic directly calls `new WebSocket()`, `fetch()`, `setTimeout()`, and reads `document.visibilityState`. No injection points for test control.

## Disconnect Scenarios

These are the real-world scenarios users experience, roughly ordered by frequency:

| Scenario | What happens | Duration | Expected behavior |
|----------|-------------|----------|-------------------|
| **Quick app switch** | User switches to another app and back | < 5s | Nothing should change. Connection likely still alive. |
| **Medium background** | User uses another app for a few minutes | 5s - 2min | WebSocket may be alive or dead. Detect stale, catch up silently. |
| **Phone sleep (short)** | Screen off, back on in a few minutes | 2 - 10min | WebSocket dead. Reconnect, replay from lastEventId, preserve scroll. |
| **Phone sleep (long)** | Phone locked overnight | 10min+ | WebSocket dead. SRP session may be expired. Reconnect or re-auth, land on same page. |
| **Network switch** | WiFi → cellular or vice versa | instant | WebSocket dead (new IP). Reconnect immediately. |
| **Airplane toggle** | Airplane on then off | 10s - 1min | WebSocket dead. Reconnect when network returns. |
| **Server restart** | Server process restarts | 1 - 10s | Clean WebSocket close. Reconnect, land on dashboard (process state gone). |
| **Relay restart** | Relay server restarts | 1 - 10s | WebSocket close. Re-register through relay, resume SRP. |
| **Tab discarded** | Chrome discards inactive tab (memory pressure) | N/A | Full page reload unavoidable. Service Worker could help restore state. |

## Proposed Approach

### 1. Testable Connection State Machine

Extract the reconnection logic into a state machine that can be driven by tests without real network events.

```
                    ┌──────────┐
                    │ connected│
                    └────┬─────┘
                         │ (connection lost / stale / visibility change)
                    ┌────▼──────────┐
                    │ reconnecting  │──── (success) ──→ connected
                    └────┬──────────┘           (catching up from lastEventId)
                         │ (repeated failure / auth expired)
                    ┌────▼──────────┐
                    │  disconnected │──── (manual retry / auto retry) ──→ reconnecting
                    └───────────────┘
```

Key rules:
- **Never navigate away while reconnecting.** Show a reconnecting indicator instead.
- **Never redirect to /login unless auth is genuinely expired** (server returned 401, not just "socket died").
- **Preserve UI state (scroll position, message list) across reconnects.** The reconnect should be invisible to the user except for a brief indicator.
- **Deduplicate reconnection triggers.** One system decides to reconnect, not five.

### 2. Connection Simulator for Tests

Create a test harness that simulates disconnect scenarios by intercepting the connection layer:

```ts
interface ConnectionSimulator {
  // Simulate scenarios
  dropConnection(): void;           // Kill WebSocket/SSE instantly
  pauseConnection(): void;          // Stop delivering messages (simulate sleep)
  resumeConnection(): void;         // Resume delivery (simulate wake)
  blockNetwork(): void;             // All new connections fail (simulate offline)
  unblockNetwork(): void;           // Allow connections again
  expireSRPSession(): void;         // Make server reject session resume

  // Observe behavior
  getUIState(): { route: string; scrollPosition: number; isReconnecting: boolean; hasContent: boolean };
  waitForState(predicate): Promise<void>;
}
```

This could be implemented as:
- A **mock connection** that wraps the real one and can be programmatically controlled
- Inject via the existing `getGlobalConnection()` / `setGlobalConnection()` mechanism
- Or a proxy WebSocket server that runs locally and can be told to drop/pause connections

### 3. Test Strategy: Three Levels

**Level 1: Unit tests (no network)**
- Test the connection state machine in isolation
- Feed it events: "connection lost", "visibility hidden 30s", "auth error 401"
- Assert state transitions and that it never navigates to /login during reconnect
- Assert lastEventId is tracked and passed on reconnect
- This is where most scenarios from the table above get tested

**Level 2: Integration tests (localhost, mock connections)**
- Use the ConnectionSimulator to drive the real React app in a test browser (Playwright)
- `simulator.dropConnection()` then assert the app shows "reconnecting" not a login page
- `simulator.pauseConnection()` for 30s then `resumeConnection()` and assert messages catch up
- `simulator.expireSRPSession()` and assert it does go to login (this is the correct case)
- These run in CI, no real network needed

**Level 3: Real network tests (manual, documented)**
- Document a manual test checklist for real device testing
- Specific steps: "Open session on phone, lock screen for 1 min, unlock, verify session catches up"
- These validate that Level 1/2 tests model reality correctly
- Run before releases, not in CI

### 4. localhost vs LAN vs Real Network

**localhost** is fine for Level 1 and 2 tests because we're mocking the connection layer, not relying on real network behavior. The ConnectionSimulator intercepts above the TCP layer.

**LAN testing** would be needed to verify that the real WebSocket/TCP behavior matches our assumptions. For example: "does a WebSocket survive 2 minutes of phone sleep over WiFi?" This is device/OS dependent and can't be mocked. Worth doing manually before releases but not automatable.

**Real relay testing** is needed for the encrypted path. A test relay running locally (the relay package already supports this) with programmatic disconnect injection would cover most cases.

### 5. What About DevTools "Offline" Mode?

DevTools offline mode is useful for one specific scenario: "what happens when the network is completely gone and comes back." It's not useful for simulating sleep (which is more like "JS paused, timers frozen, WebSocket may or may not be alive when JS resumes").

For sleep simulation in Chrome DevTools, the closest approximation is:
- `chrome://discards` to simulate tab discard
- DevTools → Performance → CPU throttling (doesn't help much)
- DevTools → Network → Offline (too aggressive)

None of these model real phone sleep well. This is why the ConnectionSimulator approach (intercepting at the application layer) is more reliable than trying to simulate at the network layer.

## Relationship to Transport Unification

This plan **requires** the always-WebSocket transport from [unified-transport.md](./unified-transport.md) (Steps 0-2) as a prerequisite.

The core issue: with two independent SSE streams (activity + session), connection health is a 3x3 matrix of `{alive, stale, dead} x {alive, stale, dead}`. Each cell produces different user-visible behavior, and partial failure (one stream alive, the other dead) is common but nearly impossible to detect, test, or recover from cleanly.

With a single multiplexed WebSocket:
- Connection health collapses to three states: `connected | reconnecting | disconnected`
- Both subscriptions fail and recover atomically — no partial states
- One heartbeat/ping to monitor, one stale threshold, one reconnect path
- The ConnectionSimulator only needs to control one socket

Without this prerequisite, the connection state machine proposed below would need to manage independent stream health, which defeats the purpose of simplification.

## Steps

### Step 1: Document current behavior with manual test matrix

Before changing anything, systematically test and document what actually happens today for each scenario in the table above. Record: what the user sees, what the console logs, whether scroll position is preserved, whether the page navigates away.

This becomes the regression baseline — we know which behaviors are correct (keep them) and which are wrong (fix them).

### Step 2: Extract connection state machine

Pull the reconnection logic out of useSSE, ActivityBus, SecureConnection, and RemoteConnectionContext into a single `ConnectionManager` that owns the state machine. The existing code becomes thin wrappers that delegate to it.

Key design decisions:
- One timer, not five, for stale detection
- Visibility change feeds into the state machine as an event, not as an independent reconnect trigger
- ConnectionGate reads from the state machine instead of having its own "am I connected?" logic
- "Go to login" only happens when the state machine reaches `disconnected` with reason `auth_expired`

### Step 3: Build ConnectionSimulator and write Level 1+2 tests

Create the simulator, wire it into Playwright tests, and write test cases for each scenario. Verify that the state machine handles all scenarios correctly and that the UI (scroll position, route, reconnecting indicator) behaves as expected.

### Step 4: Manual device testing and tuning

Run the Level 3 manual checklist on real phones. Tune thresholds (stale timeout, visibility reconnect threshold) based on real-world behavior. Update Level 1/2 tests if any assumptions were wrong.
