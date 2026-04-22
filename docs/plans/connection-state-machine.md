# Phase 6: Connection State Machine & Reconnect Testing

Replace the 5+ overlapping reconnection systems with a single `ConnectionManager` state machine. One stale timer, one visibility handler, exponential backoff, no login redirect during reconnection.

## The Problem: 5+ Overlapping Reconnection Systems

| System | Stale Timer | Visibility Handler | Reconnect Trigger |
|--------|------------|-------------------|-------------------|
| `useSessionStream` | 10s/45s interval | hidden >5s | closes subscription, calls `forceReconnect()` or reconnects after 2s |
| `ActivityBus` | 10s/45s interval | (delegated to hooks) | `forceReconnect()` or reconnects after 2s |
| `useActivityBusConnection` | -- | hidden >5s | calls `activityBus.forceReconnect()` |
| `useRemoteActivityBusConnection` | -- | hidden >5s | calls `activityBus.forceReconnect()` |
| `SecureConnection.forceReconnect()` | -- | -- | saves subscriptions, reconnects, calls onClose to re-trigger |
| `RemoteConnectionContext` | -- | -- | listens for activityBus "reconnect" event to restore React state |

These fire independently and race each other. Two stale timers, three visibility handlers, no backoff, fixed 2s delays. `ConnectionGate` can redirect to `/login` while reconnection is in-flight.

## Design

**ConnectionManager** is a standalone class (no React/DOM deps) that owns:
- State machine: `connected | reconnecting | disconnected`
- Single stale timer (10s poll, 45s threshold)
- Single visibility handler (hidden >5s triggers reconnect)
- Exponential backoff with jitter for reconnection
- Event emitter for state changes

**It does NOT own the Connection** — it calls a `reconnectFn` provided by the consumer:
- Local mode: `() => getWebSocketConnection().reconnect()`
- Remote mode: `() => getGlobalConnection()!.forceReconnect()`

**Reconnection flow:**
1. Socket dies → subscription handlers fire `onClose` → consumers clear subscription refs (but do NOT reconnect)
2. First consumer to call `connectionManager.handleClose()` transitions state to `reconnecting`
3. ConnectionManager schedules reconnect with backoff, calls `reconnectFn`
4. On success → emits `stateChange('connected')` → consumers re-subscribe
5. On failure → schedules next attempt with increasing delay
6. On non-retryable error (auth) → transitions to `disconnected`, emits `reconnectFailed`

**Singleton**: one ConnectionManager per app. Both ActivityBus and useSessionStream feed it events; first to detect a problem triggers reconnection.

**Out of scope**: ActivityBus `lastEventId` catch-up. Activity events are ephemeral (file changes, process state) — missing a few during reconnection is acceptable. `useSessionStream` already does catch-up via `lastEventId` for message history, which is the critical path.

**Mental model after this refactor:**
- **ConnectionManager** — owns state, decides when to reconnect, one place to understand reconnection policy
- **Consumers** (ActivityBus, useSessionStream) — report events in, react to state changes out, no reconnection logic
- **Transport** (WebSocketConnection, SecureConnection) — dumb pipes, reconnect when told via `reconnectFn`

---

# Phase A: Create ConnectionManager (pure additive, no existing code changes)

Mergeable on its own. Nothing changes in the app — the class just exists with full test coverage.

---

## A1. Create ConnectionManager class

**Create** `packages/client/src/lib/connection/ConnectionManager.ts` (~250 lines)

```typescript
export type ConnectionState = "connected" | "reconnecting" | "disconnected";

export interface ConnectionManagerConfig {
  baseDelayMs?: number;         // default: 1000
  maxDelayMs?: number;          // default: 30000
  maxAttempts?: number;         // default: 10
  jitterFactor?: number;        // default: 0.3
  staleThresholdMs?: number;    // default: 45000
  staleCheckIntervalMs?: number; // default: 10000
  visibilityThresholdMs?: number; // default: 5000
  timers?: TimerInterface;      // injectable for testing
  visibility?: VisibilityInterface; // injectable for testing
}

export type ReconnectFn = () => Promise<void>;

export class ConnectionManager {
  get state(): ConnectionState;
  get reconnectAttempts(): number;

  start(reconnectFn: ReconnectFn): void;
  stop(): void;

  recordEvent(): void;       // any event received, resets stale timer
  recordHeartbeat(): void;   // enables stale detection
  markConnected(): void;     // transitions to 'connected', resets backoff
  handleError(error: Error): void;  // triggers reconnect (checks isNonRetryableError)
  handleClose(error?: Error): void; // triggers reconnect; pass close error to check retryability
  forceReconnect(): void;    // immediate reconnect, resets backoff

  on(event: 'stateChange', cb: (state, prev) => void): () => void;
  on(event: 'reconnectFailed', cb: (error) => void): () => void;
}
```

Key behaviors:
- `handleClose()`/`handleError()` during `reconnecting` state → no-op (prevents double reconnect)
- `handleClose(error?)` accepts an optional error so non-retryable close codes (4001 auth, 4003 forbidden) skip reconnection — same check as `handleError()`
- Backoff: `min(maxDelay, baseDelay * 2^attempt * (1 + random * jitter))`
- **In-flight reconnect dedup**: `reconnectFn` result is stored as a promise; concurrent callers (ActivityBus + useSessionStream both calling `handleClose`) await the same promise instead of triggering parallel reconnections
- Stale check only fires if `hasReceivedHeartbeat` (backward compat)
- All timers injectable via `TimerInterface` for deterministic testing

Injectable interfaces for testing:
```typescript
export interface TimerInterface {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
  now(): number;
}

export interface VisibilityInterface {
  isVisible(): boolean;
  onVisibilityChange(cb: (visible: boolean) => void): () => void;
}
```

---

## A2. Create test helpers

**Create** `packages/client/src/lib/connection/__tests__/ConnectionSimulator.ts` (~200 lines)

```typescript
export class MockTimers implements TimerInterface {
  private _now = 0;
  advance(ms: number): void;   // fire all timers due within window
  setTimeout/clearTimeout/setInterval/clearInterval/now
}

export class MockVisibility implements VisibilityInterface {
  hide(): void;   // simulate page going to background
  show(): void;   // simulate page coming back
}

export class ConnectionSimulator {
  createMockConnection(): Connection;  // mock that records subscribe calls
  triggerOpen(): void;        // fire onOpen on all subscription handlers
  triggerClose(): void;       // fire onClose (simulate socket death)
  triggerError(err?): void;   // fire onError
  triggerEvent(type, data): void;  // fire onEvent
  triggerHeartbeat(): void;
}
```

---

## A3. Create unit tests

**Create** `packages/client/src/lib/connection/__tests__/ConnectionManager.test.ts` (~400 lines)

Unit tests with mock timers/visibility:
- State transitions: connected → reconnecting → connected, connected → reconnecting → disconnected
- Exponential backoff: delays increase 1s, 2s, 4s, 8s, 16s, 30s (capped)
- Max attempts exhausted → `disconnected` + `reconnectFailed`
- Non-retryable error → immediate `disconnected` (no backoff)
- Stale detection fires after 45s of no events (only if heartbeat seen)
- Stale detection does NOT fire without heartbeats
- Visibility: hidden >5s + visible → triggers reconnect
- Visibility: hidden <5s + visible → no-op
- `forceReconnect()` cancels pending timer, reconnects immediately
- `handleClose()` during `reconnecting` → no-op
- Concurrent reconnects serialized (one in-flight at a time)
- `stop()` clears all timers

---

## A4. Create integration tests

**Create** `packages/client/src/lib/connection/__tests__/ConnectionManager.integration.test.ts` (~300 lines)

Using MockTimers + MockVisibility + ConnectionSimulator, test full scenarios:

1. **Server restart**: connected → close → reconnect after 1s → connected
2. **Repeated failures**: close → attempt 1 (1s) → fail → attempt 2 (2s) → fail → ... → give up after 10 → `disconnected`
3. **Auth failure**: error with non-retryable code → immediate `disconnected`, no retry
4. **Stale connection**: no events for 45s → force reconnect → connected
5. **Mobile sleep/wake**: visible → hidden → advance 10s → visible → reconnect → connected
6. **Quick tab switch**: visible → hidden → advance 2s → visible → NO reconnect
7. **No double reconnect**: two consumers both call handleClose → only one reconnect
8. **Backoff reset on success**: fail 3 times (delays: 1s, 2s, 4s) → succeed → fail again → delay is 1s (reset)
9. **forceReconnect during backoff**: waiting for 8s backoff → forceReconnect → reconnects immediately
10. **No login redirect during reconnecting**: ConnectionManager state is `reconnecting` → ConnectionGate stays put
11. **Reconnect promise dedup**: two callers await reconnect concurrently → only one `reconnectFn` execution, both resolve when it completes
12. **Non-retryable close code**: `handleClose(WebSocketCloseError(4001))` → immediate `disconnected`, no retry (same as `handleError`)

---

## A5. Export singleton

**Modify** `packages/client/src/lib/connection/index.ts` — export `connectionManager` singleton.

**Verify Phase A**: `pnpm lint && pnpm typecheck && pnpm test` — all new tests pass, nothing else touched.

---

# Phase B: Wire in ConnectionManager, remove duplicates (the cutover)

All of Phase B lands in one PR. Ordering is bottom-up: transport → core consumers → React hooks → React UI → server.

---

## B1. Transport: WebSocketConnection

**Modify** `packages/client/src/lib/connection/WebSocketConnection.ts`

- Remove dead fields: `reconnectAttempts`, `maxReconnectAttempts`, `reconnectDelay`
- Add `reconnect()` method:
```typescript
async reconnect(): Promise<void> {
  this.protocol.rejectAllPending(new Error("Connection reconnecting"));
  if (this.ws) {
    this.ws.onclose = null;
    this.ws.onerror = null;
    this.ws.onmessage = null;
    this.ws.close();
    this.ws = null;
  }
  this.connectionPromise = null;
  await this.ensureConnected();
}
```

---

## B2. Transport: SecureConnection

**Modify** `packages/client/src/lib/connection/SecureConnection.ts`

Simplify `forceReconnect()` — remove subscription save/notify (ConnectionManager owns re-subscription):
```typescript
async forceReconnect(): Promise<void> {
  if (this.ws) {
    this.ws.onclose = null;
    this.ws.onerror = null;
    this.ws.onmessage = null;
    this.ws.close();
    this.ws = null;
  }
  this.protocol.rejectAllPending(new Error("Connection reconnecting"));
  // Do NOT manage subscriptions — ConnectionManager handles re-subscription
  this.connectionState = "disconnected";
  this.connectionPromise = null;
  await this.ensureConnected();
}
```

---

## B3. Core consumer: ActivityBus

**Modify** `packages/client/src/lib/activityBus.ts`

Remove:
- `RECONNECT_DELAY_MS`, `STALE_THRESHOLD_MS`, `STALE_CHECK_INTERVAL_MS` constants
- `_lastEventTime`, `_lastReconnectTime`, `staleCheckInterval`, `hasReceivedHeartbeat` fields
- `startStaleCheck()`, `stopStaleCheck()` methods
- `forceReconnect()` method
- Reconnection logic in `onError`/`onClose` handlers

Change `connectWithConnection()`:
```typescript
private connectWithConnection(connection) {
  this.wsSubscription = connection.subscribeActivity({
    onEvent: (eventType, _eventId, data) => {
      connectionManager.recordEvent();
      if (eventType === 'heartbeat') { connectionManager.recordHeartbeat(); return; }
      if (eventType === 'connected') return;
      // ... emit to listeners
    },
    onOpen: () => {
      connectionManager.markConnected();
      this._connected = true;
      if (this.hasConnected) this.emit('reconnect', undefined);
      this.hasConnected = true;
    },
    onError: (err) => {
      this._connected = false;
      this.wsSubscription = null;
      connectionManager.handleError(err);  // ConnectionManager decides what to do
    },
    onClose: (error?: Error) => {
      this._connected = false;
      this.wsSubscription = null;
      connectionManager.handleClose(error);  // pass close error so non-retryable codes are checked
    },
  });
}
```

Add: listen for ConnectionManager state changes to re-subscribe:
```typescript
// In module init or connect():
connectionManager.on('stateChange', (state) => {
  if (state === 'connected' && !this.wsSubscription) {
    this.connect();  // re-subscribe
  }
});
```

Initialize ConnectionManager with reconnect function (called once, from `connect()`):
```typescript
connectionManager.start(async () => {
  const globalConn = getGlobalConnection();
  if (globalConn?.forceReconnect) {
    await globalConn.forceReconnect();
  } else {
    await getWebSocketConnection().reconnect();
  }
});
```

Note: `start()` must be idempotent or guarded — ActivityBus may call `connect()` multiple times but `reconnectFn` should only be registered once.

---

## B4. Core consumer: useSessionStream

**Modify** `packages/client/src/hooks/useSessionStream.ts`

Remove:
- `STALE_THRESHOLD_MS`, `STALE_CHECK_INTERVAL_MS`, `VISIBILITY_RECONNECT_THRESHOLD_MS` constants
- `lastEventTimeRef`, `staleCheckIntervalRef`, `hasReceivedHeartbeatRef`, `lastVisibleTimeRef` refs
- `startStaleCheck()`, `stopStaleCheck()` callbacks
- Entire `handleVisibilityChange` listener
- Reconnection logic in `onError`/`onClose`

Simplify handlers:
```typescript
onEvent: (eventType, eventId, data) => {
  connectionManager.recordEvent();
  if (eventType === 'heartbeat') { connectionManager.recordHeartbeat(); return; }
  if (eventId) lastEventIdRef.current = eventId;
  optionsRef.current.onMessage({ ...data, eventType });
},
onOpen: () => {
  setConnected(true);
  connectionManager.markConnected();
},
onError: (error) => {
  setConnected(false);
  wsSubscriptionRef.current = null;
  mountedSessionIdRef.current = null;
  if (isNonRetryableError(error)) return;  // don't signal ConnectionManager for subscription-level 404s
  connectionManager.handleError(error);
},
onClose: () => {
  setConnected(false);
  wsSubscriptionRef.current = null;
  mountedSessionIdRef.current = null;
  // Don't reconnect here — ConnectionManager handles it
},
```

Add: listen for ConnectionManager state changes to re-subscribe:
```typescript
useEffect(() => {
  return connectionManager.on('stateChange', (state) => {
    if (state === 'connected' && sessionId && !wsSubscriptionRef.current) {
      connect();  // re-subscribe with lastEventIdRef for catch-up
    }
  });
}, [sessionId, connect]);
```

---

## B5. React hooks: useActivityBusConnection

**Modify** `packages/client/src/hooks/useActivityBusConnection.ts`

Remove visibility handler entirely. Becomes ~15 lines:
```typescript
export function useActivityBusConnection(): void {
  const { isAuthenticated, authEnabled, isLoading } = useAuth();
  useEffect(() => {
    if (isLoading) return;
    const shouldConnect = !authEnabled || isAuthenticated;
    if (shouldConnect) activityBus.connect();
    else activityBus.disconnect();
    return () => activityBus.disconnect();
  }, [isAuthenticated, authEnabled, isLoading]);
}
```

---

## B6. React hooks: useRemoteActivityBusConnection

**Modify** `packages/client/src/hooks/useRemoteActivityBusConnection.ts`

Remove visibility handler entirely. Becomes ~8 lines:
```typescript
export function useRemoteActivityBusConnection(): void {
  useEffect(() => {
    activityBus.connect();
    return () => activityBus.disconnect();
  }, []);
}
```

---

## B7. React hooks: useActivityBusState

**Modify** `packages/client/src/hooks/useActivityBusState.ts`

- Remove the 1-second `setInterval` polling loop (current workaround for no disconnect event)
- Replace with `connectionManager.on('stateChange', ...)` — event-driven, no polling
- Used by `RelayConnectionBar`; after this change, the bar updates reactively instead of on a 1s delay

---

## B8. React UI: RemoteConnectionContext + ConnectionGate

**Modify** `packages/client/src/contexts/RemoteConnectionContext.tsx`

- Remove `activityBus.on("reconnect", ...)` listener (L739-754)
- Replace with `connectionManager.on('stateChange', ...)`:
  - `'connected'` → restore React connection state, clear errors
  - `'reconnecting'` → keep current state (don't clear connection yet)
- `handleDisconnect` callback: call `connectionManager.handleError(error)` instead of immediately clearing React `connection` state. **Do NOT call `setConnection(null)` here** — defer that until ConnectionManager emits `'disconnected'` (all retries exhausted or non-retryable error). This prevents the flash-to-login problem.

**Modify** `ConnectionGate` (in `packages/client/src/RemoteApp.tsx`):
- Add early return — if `connectionManager.state === 'reconnecting'`, render children (stay on current page, don't redirect to `/login`). This is the key fix: React `connection` state may be stale during reconnection, but ConnectionManager is the source of truth for "should we redirect?"

---

## B9. React UI: RelayConnectionBar

**Modify** `packages/client/src/components/RelayConnectionBar.tsx`

- Read from `connectionManager.state` directly instead of combining RemoteConnectionContext + ActivityBus state
- `'reconnecting'` → orange bar, `'connected'` → green, `'disconnected'` → red

---

## B10. Server: WebSocket ping/pong

**Modify** `packages/server/src/routes/ws-relay.ts`

Add WebSocket ping interval so dead connections are detected server-side (not just client-side via stale heartbeats).

In `createWsRelayRoutes()`, add ping interval on open:
```typescript
onOpen(_evt, ws) {
  // ... existing code ...
  // Start WebSocket ping every 30s for dead connection detection
  const rawWs = ws.raw;
  const pingInterval = setInterval(() => {
    try {
      if (rawWs?.readyState === 1) rawWs.ping();
    } catch { clearInterval(pingInterval); }
  }, 30_000);
  // Clear on close
}
```

In `createAcceptRelayConnection()`, add ping interval for relay connections:
```typescript
const pingInterval = setInterval(() => {
  try {
    if (rawWs.readyState === rawWs.OPEN) rawWs.ping();
  } catch { clearInterval(pingInterval); }
}, 30_000);

rawWs.on("close", () => {
  clearInterval(pingInterval);
  // ... existing cleanup
});
```

No client changes needed — browsers auto-respond to pings. The `ws` library will close connections that don't pong within its timeout, which fires the client's `onclose`, which feeds into ConnectionManager.

Keep per-subscription heartbeats as-is in `subscriptions.ts` — they serve a different purpose (client-side stale detection for half-open sockets where the TCP connection is alive but the application layer is stuck).

---

## B11. Manual test checklist

**Create** `docs/testing/connection-reconnect-manual-tests.md`

Checklist for real-device testing before releases:

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| T1 | Server restart (local) | View session → restart server | Orange bar briefly, session recovers, single reconnect in console |
| T2 | Server restart (relay) | Phone via relay → restart server | Orange bar, reconnects after server up, no login redirect |
| T3 | Phone sleep 15s | Phone → lock screen 15s → unlock | Single reconnect, session catches up |
| T4 | Network toggle | Relay → airplane 5s → off | Reconnects with backoff |
| T5 | Half-open socket | Relay → kill TCP (not clean close) | Stale detection at 45s, then reconnect |
| T6 | No login redirect | Relay on /projects → kill server | Stays on /projects, orange bar |
| T7 | Auth failure | Change password → reconnect fails | Shows login form, no infinite loop |

**Verify Phase B**: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`

Manual: run through T1-T7 checklist on a real phone.

---

## Files Changed Summary

### Phase A (additive only)

| File | Action | Est. LOC |
|------|--------|----------|
| `packages/client/src/lib/connection/ConnectionManager.ts` | CREATE | +250 |
| `packages/client/src/lib/connection/__tests__/ConnectionSimulator.ts` | CREATE | +200 |
| `packages/client/src/lib/connection/__tests__/ConnectionManager.test.ts` | CREATE | +400 |
| `packages/client/src/lib/connection/__tests__/ConnectionManager.integration.test.ts` | CREATE | +300 |
| `packages/client/src/lib/connection/index.ts` | MODIFY | +5 |

### Phase B (the cutover)

| File | Action | Est. LOC |
|------|--------|----------|
| `packages/client/src/lib/connection/WebSocketConnection.ts` | MODIFY | +10 |
| `packages/client/src/lib/connection/SecureConnection.ts` | MODIFY | -20 |
| `packages/client/src/lib/activityBus.ts` | MODIFY | -120 |
| `packages/client/src/hooks/useSessionStream.ts` | MODIFY | -160 |
| `packages/client/src/hooks/useActivityBusConnection.ts` | MODIFY | -30 |
| `packages/client/src/hooks/useRemoteActivityBusConnection.ts` | MODIFY | -35 |
| `packages/client/src/hooks/useActivityBusState.ts` | MODIFY | -15 |
| `packages/client/src/contexts/RemoteConnectionContext.tsx` | MODIFY | -15, +15 |
| `packages/client/src/RemoteApp.tsx` | MODIFY | +5 |
| `packages/client/src/components/RelayConnectionBar.tsx` | MODIFY | small |
| `packages/server/src/routes/ws-relay.ts` | MODIFY | +20 |
| `docs/testing/connection-reconnect-manual-tests.md` | CREATE | +50 |

Net: ~345 lines of duplicate reconnection logic removed, ~1200 lines of new focused code (state machine + tests + simulator).
