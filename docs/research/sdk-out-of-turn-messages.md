# SDK Out-of-Turn Message Persistence Bug

## Summary

When users send messages while Claude is mid-turn (e.g., waiting on a tool execution), the messages are delivered to Claude and acknowledged in responses, but **not persisted to the JSONL session file**. This causes the messages to disappear on page reload or server restart.

## Reproduction

1. Start a session with a long-running task (e.g., `time.sleep(20)` in a Bash tool)
2. While Claude is waiting on the tool, send multiple user messages
3. Claude acknowledges receiving them in its response ("I can see your messages coming in")
4. Reload the page or restart the server
5. **Result**: The out-of-turn messages are gone

## Evidence

### Test Session
- Session ID: `bfeb5d00-385e-4ae8-bce8-6bb25792c5ae`
- Project: yepanywhere

### Messages Sent During Tool Execution
- "Ok I'm speaking out of turn"
- "And talking more"
- "How does it go?"
- "Waiting on you..."
- "I see youre very busy working!"

### Claude's Response (proving messages were received)
```
"I can see you watching!"

"I could see your messages coming in while I was waiting on the bash
commands - that's exactly what you wanted to test with the out-of-turn
messaging, right?"
```

### JSONL Analysis

The messages are **not present** in the JSONL file. Instead, we see `queue-operation: remove` entries:

```json
{"type":"queue-operation","operation":"remove","timestamp":"2026-01-08T15:31:38.775Z"}
{"type":"queue-operation","operation":"remove","timestamp":"2026-01-08T15:31:38.775Z"}
{"type":"queue-operation","operation":"remove","timestamp":"2026-01-08T15:31:38.775Z"}
{"type":"queue-operation","operation":"remove","timestamp":"2026-01-08T15:32:07.844Z"}
{"type":"queue-operation","operation":"remove","timestamp":"2026-01-08T15:32:07.844Z"}
```

These 5 `remove` operations correspond to the 5 out-of-turn messages that were sent but not persisted.

## Expected Behavior

Messages that Claude receives and acknowledges should be persisted to the JSONL file, regardless of when they were sent relative to Claude's turn. They are part of the conversation context.

## Actual Behavior

The SDK:
1. Receives the queued messages
2. Delivers them to Claude (confirmed by Claude's acknowledgment)
3. Records a `queue-operation: remove` entry
4. Does NOT write the user message as a conversation entry
5. Messages exist only in server memory until restart

## Impact

- Users lose their messages on page reload
- Conversation history is incomplete
- No way to see what was said during long-running operations
- Breaks the assumption that JSONL is a complete record of the conversation

## Workaround Options

1. **Persist on our side**: Store out-of-turn messages in our own persistence layer (e.g., `session-metadata.json`) and merge them on load
2. **Block sending while busy**: Don't allow sending messages while Claude is processing (matches SDK's apparent design)
3. **Queue and replay**: Hold messages until Claude's turn completes

## Recommendation

This appears to be a bug in the Claude SDK. The messages should be persisted since they are delivered to and processed by Claude. Filing as a bug report.

## Date
2026-01-08
