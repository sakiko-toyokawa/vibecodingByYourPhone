# Unified Transport: Always-WebSocket

This is the umbrella plan. The other two plans are steps within it.

## Problem

The client currently uses two different transports depending on context:

- **Direct/localhost**: Two independent SSE connections (activity stream + session stream) via `FetchSSE` over HTTP
- **Remote/relay**: Both streams multiplexed over a single encrypted WebSocket via `SecureConnection`

This means connection health has fundamentally different failure modes:

| | Direct (SSE) | Remote (WebSocket) |
|---|---|---|
| **Connections** | 2 independent HTTP streams | 1 multiplexed socket |
| **Partial failure** | Activity alive + session dead (or vice versa) | Impossible — both fail together |
| **Stale detection** | 2 independent 45s timers | 1 timer (but also 2 subscription timers) |
| **Reconnect** | Each stream reconnects independently | One reconnect restores both |
| **Heartbeat** | Per-stream, server sends on each SSE | Per-socket, plus per-subscription |
| **Code path (server)** | `stream.ts` + `activity.ts` via Hono SSE | `ws-relay-handlers.ts` via WebSocket messages |
| **Code path (client)** | `FetchSSE` + `useSSE` + `ActivityBus` | `SecureConnection` + `useSSE` + `ActivityBus` |

The partial failure case is the killer. When the session stream dies but activity keeps working (or vice versa), the client enters a state that's hard to detect, hard to reason about, and impossible to test without real network flakiness. The user sees "dashboard updates but session is frozen" or "session works but dashboard shows stale data."

### Why We Can't Fix Reconnection Without Fixing Transport

The [graceful reconnect plan](./graceful-reconnect-testing.md) proposes a single connection state machine. But a state machine needs a single connection to manage. With two independent SSE streams, the state machine would need to track `{activity: connected|stale|dead, session: connected|stale|dead}` — a 3x3 matrix of states with complex transition rules. With one WebSocket, it's just `connected|reconnecting|disconnected`.

The [subscription unification plan](./unify-subscription-handlers.md) eliminates server-side duplication but doesn't help with client-side complexity if the client still uses two different transport mechanisms.

## Proposed Solution

**Always use a single WebSocket connection**, even on localhost. Activity and session subscriptions are multiplexed over it. The SSE transport (`FetchSSE`, `stream.ts`, `activity.ts`) becomes dead code and is removed.

### What This Enables

- **One connection = one health check.** WebSocket ping/pong for liveness, one heartbeat timer, one stale threshold. Socket alive means everything works; socket dead means reconnect everything.
- **Atomic failure and recovery.** Both subscriptions die and recover together. No partial states.
- **One code path.** Server has one subscription handler (the unified one from the subscription plan). Client has one connection class. No transport-dependent branching.
- **Testable.** Drop the socket in a test → both streams die → reconnect → both resume. No need to simulate "one SSE dies but the other doesn't."
- **Native disconnect detection.** WebSocket close events fire immediately on TCP death. SSE requires waiting for a failed write or a missed heartbeat.

### What We Lose

- **DevTools SSE inspector.** SSE streams show up nicely in Chrome DevTools EventStream tab. WebSocket messages show up in the Messages tab but are less readable. This is a real debugging convenience loss, but we can compensate with structured logging.
- **Simplicity of curl debugging.** `curl -N localhost:3400/api/sessions/x/stream` just works for SSE. WebSocket requires wscat or similar. Again, a minor convenience.

### Architecture After

```
Client                          Server
  │                               │
  │◄──── single WebSocket ───────►│
  │                               │
  │  subscribe(activity)    ──►   │  createActivitySubscription(eventBus, emit)
  │  subscribe(session/X)   ──►   │  createSessionSubscription(process, emit)
  │  request(GET /api/...)  ──►   │  app.request() (Hono internal routing)
  │  upload_start/chunk/end ──►   │  UploadManager
  │                               │
  │  ◄── event(activity, ...)     │
  │  ◄── event(session, ...)      │
  │  ◄── response(...)            │
  │  ◄── heartbeat                │  (one heartbeat for the socket, not per-subscription)
  │                               │
  │  ping/pong (WebSocket native) │  (stale detection)
  │                               │
```

The encrypted relay path stays the same — it's already WebSocket. The difference is that localhost now uses the same protocol, just without encryption.

## Steps

### Step 0: Unify server-side subscription handlers

**Plan**: [unify-subscription-handlers.md](./unify-subscription-handlers.md)

Extract `createSessionSubscription(process, emit)` and `createActivitySubscription(eventBus, emit)` from the duplicated SSE and relay handler code. Both paths call the shared functions. This is pure server-side refactoring with no client changes.

**Deliverable**: One tested implementation of each subscription type. SSE routes and relay handlers are thin wrappers.

### Step 1: Make localhost use WebSocket transport

The client already has `WebSocketConnection` (used for local testing). The server already has `ws-relay-handlers.ts` that handles WebSocket subscriptions. The pieces exist.

**Client changes**:
- Make `WebSocketConnection` the default for localhost (currently gated behind `getWebsocketTransportEnabled()` developer flag)
- Remove the `FetchSSE` → `useSSE` → `ActivityBus` SSE code paths
- `useSSE` and `ActivityBus` always go through the WebSocket connection's `subscribeSession()` / `subscribeActivity()` methods

**Server changes**:
- Ensure the WebSocket endpoint (`/api/ws`) is always available (it already is)
- Move heartbeat from per-subscription to per-socket (one heartbeat for the WebSocket connection, not one per multiplexed stream)
- Server-side WebSocket ping/pong interval for stale detection (the `ws` library supports this natively)

**What to verify**:
- All existing E2E tests pass (they test via WebSocket already: `ws-transport.e2e.test.ts`)
- Activity stream test (`activity-stream.test.ts`) updated to use WebSocket
- Manual smoke test on localhost

### Step 2: Remove SSE transport

Once localhost is confirmed working on WebSocket:

- Delete `packages/server/src/routes/stream.ts`
- Delete SSE-specific code from `packages/server/src/routes/activity.ts` (keep the REST endpoints like `/status` and `/connections`)
- Delete `packages/client/src/lib/connection/FetchSSE.ts`
- Delete `packages/client/src/lib/connection/DirectConnection.ts` (or repurpose as WebSocket-only)
- Remove SSE-related branches from `useSSE.ts` and `ActivityBus.ts`
- Update any imports/references

**What to verify**:
- `pnpm lint && pnpm typecheck` (no dead imports)
- `pnpm test && pnpm test:e2e`
- Manual smoke test: localhost, remote/relay

### Step 3: Single connection state machine and reconnect testing

**Plan**: [graceful-reconnect-testing.md](./graceful-reconnect-testing.md)

Now that there's one socket to manage, build the connection state machine and ConnectionSimulator. This becomes tractable because:
- One socket → three states (connected/reconnecting/disconnected)
- Drop the socket → everything reconnects atomically
- Pause the socket → everything stales together
- One heartbeat/ping to monitor

### Step 4: Move heartbeat to socket level, add native ping/pong

With a single WebSocket:
- Remove per-subscription heartbeats (they're redundant)
- Add server-side WebSocket ping interval (e.g. 15s)
- Client monitors pong responses for stale detection
- If no pong received within threshold → socket is dead → reconnect

This replaces the current "send SSE comment every 30s and check on client every 10s" approach with WebSocket's native mechanism, which detects dead connections faster and more reliably.

## Migration Risk

**Low risk for Steps 0-1**: The WebSocket path already works (it's how relay/remote connections work today). Making it the default for localhost is mostly removing the SSE branch, not writing new code.

**Medium risk for Step 2**: Deleting code always risks missing a reference. Thorough typecheck and test coverage mitigate this.

**Higher risk for Step 3**: Redesigning the reconnection state machine touches many client files. The ConnectionSimulator and test suite from the reconnect plan are the safety net here.

## Open Questions

- **Should we keep SSE as a fallback?** If a user's environment somehow blocks WebSocket upgrade (extremely rare for localhost), they'd have no connection. We could keep SSE as a degraded fallback, but this reintroduces the dual-transport complexity. Recommendation: don't keep it. If WebSocket doesn't work on localhost, something is very wrong.
- **Per-subscription heartbeat vs per-socket heartbeat**: During the transition, should we keep per-subscription heartbeats for backwards compatibility with older clients? Probably not — the client and server are always deployed together.
