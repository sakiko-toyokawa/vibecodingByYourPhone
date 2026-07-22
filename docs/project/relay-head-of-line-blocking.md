# Relay Head-of-Line Blocking

## Status: Not Currently a Problem

Investigated as a possible cause of intermittent "Request timeout" errors (~1 in 30-60 requests) via relay. The actual root cause turned out to be a nonce-byte heuristic bug in `isBinaryEncryptedEnvelope` — see commit `0f4f7a1`.

This doc captures the HOL blocking analysis for future reference, since it could become relevant if session data endpoints get slower or traffic increases.

## The Mechanism

Both the Hono and raw WebSocket relay paths serialize ALL incoming messages through a single promise queue:

```typescript
// ws-relay.ts (both paths)
rawWs.on("message", (data, isBinary) => {
    messageQueue = messageQueue.then(() =>
        handleMessage(...)  // Each must COMPLETE before the next starts
    );
});
```

Inside `routeMessage`, HTTP request processing is awaited:

```typescript
case "request":
    await handleRequest(msg, send, app, baseUrl);  // blocks queue
```

`handleRequest` does `await app.fetch(...)` — the full Hono route handler round-trip. A slow request blocks all subsequent messages (requests, subscriptions, pings) in the queue.

This affects **all tunneled connections** (both relay and direct encrypted), since both tunnel HTTP requests through the WebSocket. Direct unencrypted connections use regular HTTP and are unaffected.

## Why It's Not Currently a Problem

In practice, responses are fast — the observed timeouts were caused by the nonce heuristic silently dropping ~0.78% of encrypted messages, not by queue delays. If HOL blocking were the issue, you'd see increasing latency on later requests, not instant responses with occasional total drops.

## Potential Fix

Fire-and-forget `handleRequest` instead of awaiting it:

```typescript
case "request":
    handleRequest(msg, send, app, baseUrl).catch((err) => {
        console.error(`[WS Relay] Unhandled error in handleRequest:`, err);
        try {
            send({ type: "response", id: msg.id, status: 500,
                   body: { error: "Internal server error" } });
        } catch { /* connection dead */ }
    });
    break;
```

### What Would Stay Serialized

Only `case "request"` would change. All other message types continue through the queue:
- **subscribe/unsubscribe** — ordering matters (unsubscribe must not race its subscribe)
- **upload_start/chunk/end** — offset validation requires ordering
- **ping** — lightweight, no real concern

### Risks and Caveats

- **Implicit request ordering**: If the client fires a mutation (`POST /api/sessions/:id/message`) then immediately reads (`GET /api/sessions/:id`), concurrent processing could return stale data. The current queue accidentally guarantees causal ordering between requests. This would need to be verified safe for all client call patterns.
- **`send()` concurrency**: `send()` does `JSON.stringify` + encrypt + `ws.send()`. Encryption uses random nonces (no counter), and the ws library buffers internally, so concurrent sends should be safe — but this hasn't been stress-tested.
- **Error attribution**: If a concurrent request fails, the error response goes back by request ID. But stack traces and server logs become harder to correlate since multiple requests are in-flight simultaneously.
- **No current payoff**: Since the nonce bug was the actual cause of timeouts, this optimization has no observable benefit right now. It adds concurrency to reason about for no current problem.

## Recommendation

Shelve this. If slow responses (not drops) are observed in the future — e.g., large session data loads stalling pings or subscriptions — it's a clean, low-risk change to pull out. But don't apply preemptively.

## Files

- `packages/server/src/routes/ws-relay.ts` — message queue setup (lines ~243, ~348)
- `packages/server/src/routes/ws-relay-handlers.ts` — `routeMessage`, `handleRequest`
- `packages/client/src/lib/connection/RelayProtocol.ts` — client-side 30s timeout
