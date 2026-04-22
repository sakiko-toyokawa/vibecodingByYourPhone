# Connection Matrix

This document describes the four connection modes, their reconnection behavior, and test coverage.

For server-side WebSocket auth semantics (policy vs SRP transport state), see
[`ws-auth-state-model.md`](ws-auth-state-model.md).

## Connection Modes Overview

| Mode | Transport | Auth | When Used |
|------|-----------|------|-----------|
| **DirectConnection** | fetch + SSE | Cookies | Default for localhost/LAN |
| **WebSocketConnection** | Single WS | Cookies | Dev setting enabled |
| **SecureConnection** | Encrypted WS | SRP + NaCl | Remote mode (direct) |
| **SecureConnection + Relay** | Encrypted WS via relay | SRP + NaCl | Remote mode (NAT traversal) |

### Selection Logic

From `packages/client/src/hooks/useConnection.ts`:

```
1. Global SecureConnection set? → Use SecureConnection (remote mode)
2. Developer setting websocketTransportEnabled? → Use WebSocketConnection
3. Default → Use DirectConnection
```

## Detailed Connection Modes

### 1. DirectConnection (SSE + fetch)

**Files:**
- Client: `packages/client/src/lib/connection/DirectConnection.ts`
- SSE: `packages/client/src/lib/connection/FetchSSE.ts`

**Transport:**
- API calls: native `fetch()` with credentials
- Streaming: Custom `FetchSSE` (not native EventSource)
  - Why custom? Detect HTTP status codes (401/403), control reconnection

**Auth:**
- Cookie-based session (implicit via `credentials: "include"`)
- 401/403 triggers `authEvents.signalLoginRequired()`

**Initial Data Load:**
- Session: REST call to `/api/sessions/:id/jsonl` returns full history
- Live updates: SSE to `/api/sessions/:id/stream`

**Message Flow:**
```
┌─────────────┐     REST /jsonl      ┌─────────────┐
│   Client    │ ──────────────────▶  │   Server    │
│             │                      │             │
│             │     SSE /stream      │             │
│             │ ◀════════════════════│             │
└─────────────┘                      └─────────────┘
```

---

### 2. WebSocketConnection

**Files:**
- Client: `packages/client/src/lib/connection/WebSocketConnection.ts`
- Server: `packages/server/src/routes/ws.ts`

**Transport:**
- Single WebSocket for all traffic
- Multiplexed requests via `{ id, type: "request" }` / `{ id, type: "response" }`

**Auth:**
- Cookie-based (cookies sent in WS upgrade)

**When Used:**
- Developer setting only (for testing WS protocol without encryption)

---

### 3. SecureConnection (Encrypted WebSocket)

**Files:**
- Client: `packages/client/src/lib/connection/SecureConnection.ts`
- Crypto: `packages/client/src/lib/connection/srp-client.ts`, `nacl-wrapper.ts`
- Server: `packages/server/src/routes/ws-relay.ts`, `ws-relay-handlers.ts`

**Transport:**
- Single WebSocket with all messages encrypted
- Encryption: XSalsa20-Poly1305 (NaCl secretbox)

**Auth:**
- SRP-6a zero-knowledge password proof
- Session key derived from SRP, never transmitted
- Session resumption supported (skip full SRP on reconnect)

**Protocol:**
```
Full SRP Handshake:
  Client                          Server
    │                               │
    │ ── srp_hello (identity) ────▶ │
    │ ◀── srp_challenge (salt, B) ──│
    │ ── srp_proof (A, M1) ───────▶ │
    │ ◀── srp_verify (M2, sessionId)│
    │                               │
    │   [session key K established] │
    │                               │
    │ ══ encrypted traffic ════════▶│

Session Resume (stored session):
  Client                          Server
    │                               │
    │ ── srp_resume ──────────────▶ │  (sessionId + encrypted timestamp)
    │ ◀── srp_resumed ─────────────│  (or srp_invalid → fall back to full SRP)
    │                               │
    │ ══ encrypted traffic ════════▶│
```

---

### 4. SecureConnection + Relay

**Additional Files:**
- Client context: `packages/client/src/contexts/RemoteConnectionContext.tsx`
- Relay server: `packages/relay/src/`

**When Used:**
- Remote access through public relay for NAT traversal

**Flow:**
```
┌──────────┐    ┌───────────┐    ┌─────────────┐
│  Phone   │───▶│   Relay   │◀───│ Yepanywhere │
│          │    │           │    │   Server    │
│ SRP+NaCl │    │ opaque    │    │ SRP+NaCl    │
│          │    │ blobs     │    │             │
└──────────┘    └───────────┘    └─────────────┘
```

Relay only sees encrypted blobs. SRP handshake passes through relay to yepanywhere server.

---

## Reconnection Behavior

### Trigger Points

| Trigger | Description |
|---------|-------------|
| Network drop | WebSocket closes, SSE errors |
| Device sleep | Laptop lid close, phone screen off |
| Page visibility | Tab hidden > 5 seconds |
| Server restart | Connection closes with code |

### Reconnection by Mode

#### DirectConnection (SSE)

| Event | Behavior |
|-------|----------|
| SSE error | FetchSSE auto-reconnects after 2s |
| SSE close | FetchSSE auto-reconnects after 2s |
| 401/403 | Stop reconnecting, signal login required |
| Reconnect | `connected` event triggers `fetchNewMessages()` with `?afterMessageId` |

**Note:** SSE `lastEventId` is ignored, but JSONL incremental fetch handles missed messages.

#### WebSocketConnection

| Event | Behavior |
|-------|----------|
| WS close | `ensureConnected()` on next request |
| Max retries | 3 attempts with 1s delay |
| Pending requests | Rejected with `WebSocketCloseError` |
| Subscriptions | Notified via `onClose()` callback |

#### SecureConnection (Direct + Relay)

| Event | Behavior |
|-------|----------|
| WS close | `ensureConnected()` attempts reconnect |
| Session stored | Try `srp_resume` first |
| Session invalid | Fall back to full SRP |
| Relay mode | Use `reconnectThroughRelay()` |
| Relay failure | Throw `RelayReconnectRequiredError` |

**Mobile wake handling** (`useRemoteActivityBusConnection.ts:40-57`):
- Listens to `document.visibilitychange`
- If hidden > 5 seconds, calls `forceReconnect()`
- Forces WebSocket close and full reconnection
- All subscriptions notified to re-subscribe

---

## Data Sync After Reconnection

### Session Messages

**Initial page load:**
1. REST call to `/api/sessions/:id` loads full JSONL history
2. SSE connects to `/api/sessions/:id/stream`
3. Client buffers SSE messages until REST load completes
4. Client merges with duplicate detection via `getMessageId()`

**On SSE reconnect (laptop wake, network recovery):**
1. SSE reconnects (auto-reconnect after 2s)
2. Server sends `connected` event
3. Client calls `fetchNewMessages()` with `?afterMessageId=<lastKnownId>` (`useSession.ts:774`)
4. Server returns only messages after that ID (`reader.ts:201-207`)
5. Client merges new messages via `mergeJSONLMessages()`
6. SSE also replays its in-memory buffer (last 30-60s of SDK messages)
7. Duplicate detection ensures no duplicates

**Key code:**
- `lastMessageIdRef` tracks last known message ID (`useSessionMessages.ts:112`)
- `fetchNewMessages()` uses incremental API (`useSessionMessages.ts:294-320`)
- Server `afterMessageId` implemented in all readers (`reader.ts`, `gemini-reader.ts`, etc.)
- Unit tested: `packages/server/test/incremental-session.test.ts`

**Example scenario:**
```
1. Open session, see 10 messages → lastMessageIdRef = msg10.id
2. Close laptop
3. 100 messages added on another computer
4. Open laptop
5. SSE reconnects → "connected" event fires
6. fetchNewMessages() requests ?afterMessageId=msg10
7. Server returns messages 11-110
8. Client now has all 110 messages
```

### Activity Events

**Current flow:**
- No historical sync - only events after subscription
- Visibility change triggers `forceReconnect()` which re-subscribes

**Gap:** If offline for N seconds, miss session status changes during that window.

---

## Session Persistence

| Mode | What's Stored | Where | Purpose |
|------|---------------|-------|---------|
| DirectConnection | Browser profile ID | localStorage | Correlate tabs |
| WebSocketConnection | Nothing | - | Stateless |
| SecureConnection | Session key, URL, username | localStorage | Skip SRP on refresh |
| SecureConnection + Relay | + relay URL, relay username | localStorage | Reconnect through relay |

**Stored session format:**
```typescript
interface StoredSession {
  wsUrl: string;
  username: string;
  sessionId: string;
  sessionKey: string;  // Base64-encoded 32 bytes
}
```

---

## Current Gaps

### 1. SSE Stream `lastEventId` Not Implemented (Low Impact)

**Status:** Not implemented
**Impact:** Low
**Location:** `packages/server/src/routes/stream.ts`

The SSE stream ignores the `?lastEventId=X` parameter for streaming events (SDK messages). However:
- SDK messages clear every 30-60s (two clearing buckets)
- JSONL incremental fetch IS implemented via `?afterMessageId=X` (see above)
- On reconnect, client fetches missed JSONL messages and SSE replays its buffer
- This covers the gap for any realistic offline period

### 2. Activity Stream Has No Catch-up

**Status:** Not implemented
**Impact:** Medium (can miss status changes while offline)

After reconnect, client only sees new activity events. If session status changed while disconnected, client may show stale state until next update.

**Workaround:** Client can refresh session list on reconnect.

### 3. In-Flight Requests Lost on Reconnect

**Status:** By design
**Impact:** Medium

When WebSocket closes:
- Pending requests are rejected with `WebSocketCloseError`
- Client must retry at application level
- No automatic request queuing/replay

### 4. No E2E Test for Reconnection + Incremental Fetch

**Status:** Missing test coverage
**Impact:** Medium (feature works but not regression-tested)

The JSONL incremental fetch is unit tested (`incremental-session.test.ts`), but there's no browser e2e test that simulates:
1. Connect to session, see messages
2. Disconnect (simulate laptop close)
3. Messages added while disconnected
4. Reconnect
5. Verify all messages fetched

This should be added to catch regressions in the full reconnection flow.

---

## E2E Test Coverage

### What's Tested

| Scenario | Mode | Test File |
|----------|------|-----------|
| Basic WS request/response | WebSocket | `ws-transport.e2e.test.ts` |
| WS event subscriptions | WebSocket | `ws-transport.e2e.test.ts` |
| WS file uploads | WebSocket | `ws-transport.e2e.test.ts` |
| SRP handshake | Secure WS | `ws-secure.e2e.test.ts` |
| Encrypted traffic | Secure WS | `ws-secure.e2e.test.ts` |
| Session resume on refresh | Relay | `relay-integration.spec.ts` |
| Wrong password error | Relay | `relay-integration.spec.ts` |
| Relay message forwarding | Relay | `relay.e2e.test.ts` |

### What's NOT Tested

| Scenario | Gap |
|----------|-----|
| SSE transport | No SSE e2e tests at all |
| Reconnection + incremental fetch | Feature works, but no e2e regression test |
| Network interruption simulation | Only graceful disconnects tested |
| Device sleep / wake recovery | Not simulated in tests |
| Long-lived connections | No duration tests |
| Multi-tab coordination | Not tested |
| Partial message recovery | Not tested |

### Recommended New Tests

1. **Reconnection + incremental message fetch** (HIGH PRIORITY)
   - Connect to session, receive N messages
   - Simulate disconnect (close SSE/WS)
   - Add messages to JSONL while disconnected
   - Reconnect
   - Verify client receives all messages via `?afterMessageId`

2. **SSE basic flow** - Connect, receive events, verify order

3. **Visibility change** - Simulate tab hidden/visible, verify reconnect

4. **Concurrent reconnection** - Multiple subscriptions reconnecting simultaneously

---

## Key Code Locations

### Client Connection Layer
```
packages/client/src/lib/connection/
├── DirectConnection.ts      # SSE + fetch
├── WebSocketConnection.ts   # WS protocol
├── SecureConnection.ts      # SRP + encryption
├── FetchSSE.ts              # Custom SSE implementation
├── srp-client.ts            # SRP-6a client
├── nacl-wrapper.ts          # NaCl encryption
└── types.ts                 # Connection interface
```

### Hooks
```
packages/client/src/hooks/
├── useConnection.ts         # Mode selection
├── useSSE.ts                # SSE subscription logic
└── useSessionMessages.ts    # Message merging/buffering
```

### Server Streaming
```
packages/server/src/routes/
├── stream.ts                # SSE endpoint
├── activity.ts              # Activity SSE
├── ws.ts                    # Unencrypted WS
├── ws-relay.ts              # Encrypted WS endpoint
└── ws-relay-handlers.ts     # SRP + message handling
```

---

## See Also

- [Relay Design](relay-design.md) - Detailed relay protocol and implementation
- [Remote Access](remote-access.md) - User-facing remote access options
