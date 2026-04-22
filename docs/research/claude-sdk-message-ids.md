# Claude SDK Message ID Investigation

Investigation date: 2025-01-05

## Summary

**The Claude Agent SDK uses consistent UUIDs between streaming SSE events and JSONL persistence.** Both user and assistant messages have the same `uuid` field whether received via real-time streaming or read from disk.

## ID Types in the SDK

There are three distinct ID types in the streaming flow:

| ID | Location | Format | Purpose |
|----|----------|--------|---------|
| `stream_event.uuid` | Event wrapper | UUID | Identifies the SSE event envelope |
| `event.message.id` | `message_start` event | `msg_xxx...` | Anthropic API message ID |
| `message.uuid` | User/assistant messages | UUID | SDK conversation DAG identifier |

Only the third (`message.uuid`) is relevant for message correlation. The other two are transient.

## Empirical Verification

Tested with session `5af3eb9b-c0b3-4318-a314-3d9b99e3cfa9` on 2025-01-05.

### Assistant Messages

SSE (from `sdk-raw.jsonl`):
```
{"type":"assistant","uuid":"c9cd4ab0-6a7f-42c4-9f2c-b1fe49193137"}
{"type":"assistant","uuid":"b26dda6d-4acb-4111-b6a3-708f30d058f3"}
{"type":"assistant","uuid":"aaf5b228-353e-4188-8ed9-d519c4661e66"}
```

JSONL (from session file):
```
{"type":"assistant","uuid":"c9cd4ab0-6a7f-42c4-9f2c-b1fe49193137"}
{"type":"assistant","uuid":"b26dda6d-4acb-4111-b6a3-708f30d058f3"}
{"type":"assistant","uuid":"aaf5b228-353e-4188-8ed9-d519c4661e66"}
```

**Result: UUIDs match exactly.**

### User Messages

SSE:
```
{"uuid":"941987b4-0881-4aa3-9f2b-14674c400fe3"}
{"uuid":"6239d4a0-dfbe-4e5d-9dae-5dd8464847d4"}
{"uuid":"6403eef7-d71d-49f7-80ba-7a2832bf1cb2"}
```

JSONL:
```
{"uuid":"941987b4-0881-4aa3-9f2b-14674c400fe3"}
{"uuid":"6239d4a0-dfbe-4e5d-9dae-5dd8464847d4"}
{"uuid":"6403eef7-d71d-49f7-80ba-7a2832bf1cb2"}
```

**Result: UUIDs match exactly.**

## Streaming Event Sequence

Within one API response, the SDK emits:

```
message_start (stream_event, uuid=A, event.message.id="msg_xxx")
  content_block_start (stream_event, uuid=B)
  content_block_delta (stream_event, uuid=C) [repeated]
  content_block_stop (stream_event, uuid=D)
message_stop (stream_event, uuid=E)
assistant (type="assistant", uuid=F)  <-- This is the real message UUID
```

- UUIDs A-E are stream event envelope IDs (all different, not used for correlation)
- UUID F is the actual message UUID that matches JSONL
- `event.message.id` ("msg_xxx") is Anthropic's API ID, not used by us

## When Content Matching IS Needed

Content+parent matching (in `mergeMessages.ts`) is only needed for **client-generated optimistic messages**:

1. User types a message
2. Client immediately displays it with `id: "temp-${Date.now()}"`
3. SDK eventually emits the real message with `uuid: "abc-123-..."`
4. Content matching replaces temp message with real one

This is NOT needed for:
- SDK user messages (uuid matches JSONL)
- SDK assistant messages (uuid matches JSONL)
- stream_event correlation (envelope IDs are discarded)

## Code References

- Message ID helper: `packages/client/src/lib/mergeMessages.ts:8` (`getMessageId`)
- Temp ID generation: `packages/client/src/hooks/useSession.ts:225`
- Streaming ID capture: `packages/client/src/hooks/useSession.ts:672` (from `message_start`)
- Content matching: `packages/client/src/lib/mergeMessages.ts:171` (user messages only)

## Conclusion

The SDK maintains UUID consistency across its emission and persistence paths. The complexity in `mergeMessages.ts` exists solely to handle the client's optimistic UI pattern, not SDK inconsistencies.

**Safe assumptions:**
- `assistant.uuid` from SSE === `assistant.uuid` from JSONL
- `user.uuid` from SSE === `user.uuid` from JSONL
- `stream_event.uuid` is throwaway (envelope only)
- `message_start.event.message.id` is Anthropic's ID (we don't use it for correlation)
