# Unify Session & Activity Subscription Handlers

> **Part of**: [Unified Transport plan](./unified-transport.md) (Step 0)
>
> This is the server-side foundation. It eliminates duplicated subscription logic so that
> when we drop SSE and go always-WebSocket, there's one tested implementation to wire up.

## Problem

Session and activity streaming have two fully duplicated code paths:

1. **SSE path** (`packages/server/src/routes/stream.ts` and `activity.ts`) — serves direct HTTP clients via Hono's `streamSSE()`
2. **Relay/WebSocket path** (`packages/server/src/routes/ws-relay-handlers.ts`, functions `handleSessionSubscribe` and `handleActivitySubscribe`) — serves WebSocket and encrypted relay clients

Both paths subscribe to the same underlying event sources (`process.subscribe()` for sessions, `eventBus.subscribe()` for activity) and perform identical logic:

- Session subscriptions (~100 lines each): lazy `StreamAugmenter` creation, process event handling (message/state-change/mode-change/error/claude-login/session-id-changed/complete), streaming text accumulation for late joiners, catch-up augmentation, message history replay, heartbeat, cleanup.
- Activity subscriptions (~40 lines each): eventBus forwarding, heartbeat, browser connection tracking, cleanup.

The only difference is the output target — one calls `stream.writeSSE()`, the other calls `send({type: "event", ...})`.

### Consequences

- **Divergent behavior**: The SSE path subscribes to process events *before* sending the "connected" event (preventing a race where a state change during replay is lost). The relay path does not — it sends "connected" and replays history first, then subscribes. This is a latent bug.
- **Feature drift**: Any new event type or augmentation logic must be added in two places. Easy to miss one.
- **No unit tests**: Neither subscription path has unit tests. The relay handlers are structurally testable (they take a `send` callback) but nobody wrote tests. The SSE path is entangled with Hono's streaming API, making it hard to test in isolation.
- **Confusing architecture**: Understanding the streaming system requires reading two parallel implementations and mentally diffing them for differences.

## Proposed Solution

Extract the shared subscription logic into standalone functions that take an `emit` callback. Both the SSE and relay paths become thin wrappers providing their own `emit` implementation.

### Target API

```ts
// Session subscription
function createSessionSubscription(
  process: ClaudeProcess,
  emit: (eventType: string, data: unknown) => void,
  options?: { onError?: (err: unknown) => void },
): { cleanup: () => void }

// Activity subscription
function createActivitySubscription(
  eventBus: EventBus,
  emit: (eventType: string, data: unknown) => void,
  options?: { onError?: (err: unknown) => void },
): { cleanup: () => void }
```

Each function encapsulates:
- Subscribing to the event source
- Sending the "connected" event
- Replaying history (session only)
- Augmentation lifecycle (session only)
- Heartbeat interval
- Cleanup on teardown

The SSE route wraps `emit` as:
```ts
const emit = (eventType, data) => stream.writeSSE({
  id: String(eventId++), event: eventType, data: JSON.stringify(data)
})
```

The relay handler wraps `emit` as:
```ts
const emit = (eventType, data) => send({
  type: "event", subscriptionId, eventType, eventId: String(eventId++), data
})
```

## Steps

### Step 1: Write unit tests for current relay handlers

**Goal**: Establish a behavioral baseline before changing anything.

**Files to create**: `packages/server/test/routes/subscription-handlers.test.ts`

**Approach**: The relay functions `handleSessionSubscribe` and `handleActivitySubscribe` already take a `send` callback, making them testable without any transport infrastructure. Create mock versions of:
- `Supervisor` / `ClaudeProcess` (with `subscribe()`, `getMessageHistory()`, `getStreamingContent()`, `state`, etc.)
- `EventBus` (with `subscribe()`)
- `send` function that collects messages into an array

**Test cases for session subscription**:
- Sends "connected" event with correct process state
- Replays message history
- Forwards process events (message, state-change, mode-change, error, complete, etc.)
- Flushes augmenter on complete
- Calls cleanup (unsubscribe + clear heartbeat) when unsubscribed
- Handles streaming text accumulation and catch-up

**Test cases for activity subscription**:
- Sends "connected" event
- Forwards eventBus events with correct eventType
- Heartbeat fires on interval
- Cleanup unsubscribes from eventBus and disconnects browser tracking

**Key files to understand**:
- `packages/server/src/routes/ws-relay-handlers.ts` (lines 415-703) — the functions under test
- `packages/server/src/supervisor/types.ts` — `ClaudeProcess` and `ProcessEvent` interfaces
- `packages/server/src/watcher/EventBus.ts` — `EventBus` interface
- `packages/server/src/augments/index.ts` — `createStreamAugmenter` and related functions

### Step 2: Extract shared subscription core

**Goal**: Move the duplicated logic into shared functions without changing behavior.

**File to create**: `packages/server/src/subscriptions.ts` (or similar)

**Approach**:
1. Create `createSessionSubscription(process, emit, options)` by extracting the body of `handleSessionSubscribe` from `ws-relay-handlers.ts`.
2. Create `createActivitySubscription(eventBus, emit, options)` by extracting from `handleActivitySubscribe`.
3. The shared code should use the SSE path's subscribe-before-connected ordering (fixing the relay path's race condition).
4. Update tests from Step 1 to test the extracted functions directly.
5. Verify tests still pass.

**Design notes**:
- `emit` should be synchronous-friendly (fire-and-forget) since the relay path's `send` is sync while SSE's `writeSSE` is async. The shared code can call `emit` and let the wrapper handle async/error behavior.
- Heartbeat interval ownership moves into the shared function (returned via cleanup).
- `eventId` counter is managed internally.

### Step 3: Rewire both paths to use shared core

**Goal**: Replace duplicated code in both SSE routes and relay handlers with calls to the shared functions.

**Files to modify**:
- `packages/server/src/routes/stream.ts` — replace ~100 lines of session subscription logic with `createSessionSubscription(process, sseEmit)`
- `packages/server/src/routes/activity.ts` — replace ~40 lines of activity subscription logic with `createActivitySubscription(eventBus, sseEmit)`
- `packages/server/src/routes/ws-relay-handlers.ts` — replace `handleSessionSubscribe` and `handleActivitySubscribe` bodies with calls to shared functions

**Verification**:
- Unit tests from Step 1 pass
- E2E tests pass: `pnpm test:e2e` (covers `ws-transport.e2e.test.ts`, `ws-secure.e2e.test.ts`)
- Existing tests pass: `pnpm test` (covers `activity-stream.test.ts`)
- Manual smoke test: connect via direct SSE, verify streaming works
- Manual smoke test: connect via relay, verify streaming works
- `pnpm lint && pnpm typecheck`

**Bonus fix**: The race condition in the relay path (subscribe-after-connected) gets fixed automatically since the shared core uses the correct ordering from the SSE path.
