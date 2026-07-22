# Rapid Message Parent UUID Analysis

**Session ID:** `35e3c628-cf13-495a-8bde-e0fe1f2f1be7`
**Test:** Send 3 messages ("1", "2", "3") simultaneously with 0ms delay

---

## Key Finding

**Rapid messages are LINEARIZED, not branched.** Even though all 3 messages were queued at the exact same millisecond, the SDK processes them sequentially. Each user message's `parentUuid` points to the PREVIOUS assistant response, not to a common ancestor.

---

## Timeline

| Timestamp | Event | UUID | parentUuid |
|-----------|-------|------|------------|
| 18:13:24.884 | Initial user msg | `d4b27b4b-...` | `null` |
| 18:13:29.033 | Assistant response | `c0cfd1c9-...` | `d4b27b4b-...` |
| **18:13:34.051** | **Queue: "1", "2", "3"** | — | — |
| 18:13:34.058 | User "1" processed | `9c6d41d6-...` | `c0cfd1c9-...` |
| 18:13:37.946 | Assistant to "1" | `5fff4069-...` | `9c6d41d6-...` |
| 18:13:37.982 | User "2" processed | `054c8226-...` | `5fff4069-...` |
| 18:13:42.107 | Assistant to "2" | `91fd658b-...` | `054c8226-...` |
| 18:13:42.138 | User "3" dequeued | — | — |

---

## Parent UUID Chain (from JSONL)

```
Initial User (d4b27b4b) ─── parentUuid: null
         │
         ▼
Initial Assistant (c0cfd1c9) ─── parentUuid: d4b27b4b
         │
         ▼
User "1" (9c6d41d6) ─── parentUuid: c0cfd1c9  ◄── Points to previous assistant
         │
         ▼
Assistant to "1" (5fff4069) ─── parentUuid: 9c6d41d6
         │
         ▼
User "2" (054c8226) ─── parentUuid: 5fff4069  ◄── Points to previous assistant
         │
         ▼
Assistant to "2" (91fd658b) ─── parentUuid: 054c8226
         │
         ▼
User "3" (next...) ─── parentUuid: 91fd658b  ◄── Points to previous assistant
```

---

## How It Works

1. **Queue all at once:** Messages "1", "2", "3" enter the `MessageQueue` at `18:13:34.051Z`
2. **Sequential dequeue:** SDK calls `queue.generator().next()` which yields one message at a time
3. **Wait for response:** Each message waits for Claude to respond before the next is dequeued
4. **Dynamic parent:** The SDK assigns `parentUuid` at dequeue time, pointing to the latest assistant message

---

## Why No Branching?

The `MessageQueue.generator()` is an async generator that yields messages one at a time:

```typescript
async *generator(): AsyncGenerator<SDKUserMessage> {
  while (true) {
    const message = await this.next();  // Blocks until SDK requests next
    yield this.toSDKMessage(message);
  }
}
```

The SDK controls the pace - it only calls `.next()` after processing the previous message. This guarantees linear ordering even when multiple messages are queued simultaneously.

---

## Implications

| Scenario | Result |
|----------|--------|
| Queue 3 messages at once | Linear chain, not branches |
| Each message sees | Full conversation including previous rapid messages |
| DAG structure | Always linear for rapid messages |
| Branching requires | Forking from a specific parentUuid (not supported in current queue) |

---

## Raw JSONL Evidence

```jsonl
// All 3 queued at same instant
{"type":"queue-operation","operation":"dequeue","timestamp":"2026-01-05T18:13:34.051Z",...}

// But processed sequentially with linear parent chain:
{"type":"user","uuid":"9c6d41d6-...","parentUuid":"c0cfd1c9-...","message":{"content":"1"},...}
{"type":"assistant","uuid":"5fff4069-...","parentUuid":"9c6d41d6-...",...}
{"type":"user","uuid":"054c8226-...","parentUuid":"5fff4069-...","message":{"content":"2"},...}
```
