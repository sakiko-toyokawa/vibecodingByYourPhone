# Debug API Specification

**Date:** 2025-01-05
**Status:** Proposed
**Location:** Maintenance server (port 3401)

## Motivation

During investigation of Claude SDK message ID behavior, we identified several scenarios that are difficult to test and debug:

1. **Rapid message submission** - What happens when multiple user messages are sent before Claude finishes responding? Do they create branching DAG structures?

2. **SSE vs JSONL comparison** - While we confirmed UUIDs match between streaming and persistence (see `docs/research/claude-sdk-message-ids.md`), having a programmatic way to compare these would catch regressions.

3. **Parent chain behavior** - SSE messages arrive with `parentUuid: null`, while JSONL has proper parent chains. Understanding this timing is important for client-side message ordering.

4. **Reproducible test scenarios** - Currently, testing message flows requires manual interaction. A debug API enables scripted, reproducible test cases.

## Design Decisions

### Location: Maintenance Server

The debug API lives on the maintenance server (default port 3401) because:

- Not exposed on main application port
- Can be disabled in production via `MAINTENANCE_PORT=0`
- Has access to Supervisor internals for introspection
- Consistent with other diagnostic endpoints (`/status`, `/inspector`, etc.)

### Blocking Mechanism

The blocking send operation uses the existing `process.subscribe()` pattern:

```typescript
const unsubscribe = process.subscribe((event) => {
  if (event.type === 'state-change' && event.state.type === 'idle') {
    unsubscribe();
    // Return response
  }
});
process.queueMessage(message);
```

This leverages the existing event system without adding new infrastructure.

### Data Sources

| Data | Source | Notes |
|------|--------|-------|
| SSE messages | `process.getMessageHistory()` | In-memory, includes all `stream_event`s |
| JSONL messages | `ClaudeSessionReader.getSession()` | From disk, authoritative |
| Raw stream log | `~/.yep-anywhere/logs/sdk-raw.jsonl` | All SDK events, for deep debugging |

## API Endpoints

### GET /debug/sessions

List all active sessions with process info.

**Response:**
```json
{
  "sessions": [
    {
      "sessionId": "5af3eb9b-c0b3-4318-a314-3d9b99e3cfa9",
      "processId": "abc-123",
      "state": "idle",
      "messageCount": 173,
      "streamEventCount": 7992,
      "startedAt": "2025-01-05T10:00:00Z",
      "idleSince": "2025-01-05T10:30:00Z"
    }
  ]
}
```

### GET /debug/sessions/:sessionId

Get detailed session info including message history.

**Query Parameters:**
- `includeStreamEvents` (boolean, default: false) - Include `stream_event` messages
- `limit` (number, default: 100) - Max messages to return
- `offset` (number, default: 0) - Pagination offset

**Response:**
```json
{
  "sessionId": "5af3eb9b-...",
  "state": "idle",
  "messages": [
    {
      "uuid": "cdccbbed-ab56-...",
      "type": "user",
      "parentUuid": null,
      "contentPreview": "can you tell me what happens..."
    },
    {
      "uuid": "027aad8d-fc4a-...",
      "type": "assistant",
      "parentUuid": "cdccbbed-ab56-...",
      "contentPreview": "[text block, tool_use block]"
    }
  ],
  "stats": {
    "userMessages": 88,
    "assistantMessages": 173,
    "streamEvents": 7992,
    "totalInMemory": 8253
  }
}
```

### GET /debug/sessions/:sessionId/compare

Compare SSE (in-memory) messages with JSONL (on-disk) messages.

**Response:**
```json
{
  "sessionId": "5af3eb9b-...",
  "sse": {
    "count": 261,
    "userCount": 88,
    "assistantCount": 173
  },
  "jsonl": {
    "count": 261,
    "userCount": 88,
    "assistantCount": 173
  },
  "comparison": {
    "matching": 261,
    "inSseOnly": [],
    "inJsonlOnly": [],
    "uuidMismatches": [],
    "parentUuidDiffs": [
      {
        "uuid": "cdccbbed-...",
        "sseParentUuid": null,
        "jsonlParentUuid": "027aad8d-..."
      }
    ]
  }
}
```

### POST /debug/sessions/:sessionId/send

Send a message to an existing session.

**Request:**
```json
{
  "message": "Hello, Claude",
  "blocking": true,
  "timeoutMs": 60000
}
```

**Response (blocking: false):**
```json
{
  "queued": true,
  "position": 0
}
```

**Response (blocking: true):**
```json
{
  "state": "idle",
  "durationMs": 5432,
  "newMessages": [
    {
      "uuid": "new-user-uuid",
      "type": "user",
      "contentPreview": "Hello, Claude"
    },
    {
      "uuid": "new-assistant-uuid",
      "type": "assistant",
      "contentPreview": "Hello! How can I help..."
    }
  ]
}
```

### POST /debug/sessions/:sessionId/rapid

Send multiple messages rapidly for testing concurrent/queued message behavior.

**Request:**
```json
{
  "messages": [
    "First message",
    "Second message",
    "Third message"
  ],
  "delayMs": 0,
  "blocking": true,
  "timeoutMs": 120000
}
```

**Response:**
```json
{
  "sent": 3,
  "durationMs": 15234,
  "results": [
    {
      "message": "First message",
      "queuedAt": "2025-01-05T10:00:00.000Z",
      "uuid": "msg-1-uuid"
    },
    {
      "message": "Second message",
      "queuedAt": "2025-01-05T10:00:00.001Z",
      "uuid": "msg-2-uuid"
    },
    {
      "message": "Third message",
      "queuedAt": "2025-01-05T10:00:00.002Z",
      "uuid": "msg-3-uuid"
    }
  ],
  "finalState": "idle",
  "dagStructure": {
    "description": "Linear chain or branching detected",
    "branches": 1,
    "leafNodes": ["msg-3-uuid"]
  }
}
```

### POST /debug/sessions/create

Create a new session for testing (without going through the full client flow).

**Request:**
```json
{
  "projectPath": "/home/user/code/myproject",
  "message": "Initial message",
  "model": "claude-sonnet-4-20250514",
  "blocking": true,
  "timeoutMs": 60000
}
```

**Response:**
```json
{
  "sessionId": "new-session-uuid",
  "processId": "process-uuid",
  "state": "idle",
  "messages": [...]
}
```

### DELETE /debug/sessions/:sessionId

Terminate a debug session and clean up.

**Response:**
```json
{
  "terminated": true,
  "reason": "debug-cleanup"
}
```

## Implementation Notes

### Process State Machine

```
running → idle (after Claude responds)
idle → running (when message queued)
idle → terminated (after 5 min timeout)
running → waiting-input (tool approval needed)
waiting-input → running (after approval)
```

The blocking mechanism waits for `idle` state, which indicates Claude has finished responding.

### Message History Lifecycle

- `process.getMessageHistory()` returns all messages emitted via SSE
- Includes `stream_event` messages (content_block_delta, etc.)
- Cleared when process is terminated (5 min after going idle)
- No size cap currently - grows unbounded during session

### Memory Considerations

A typical session generates:
- ~100-200 user/assistant messages
- ~8000 stream_event messages (for a complex interaction)

At roughly 1-2KB per stream_event, this is ~10-15MB per active session. Consider adding:

1. **Stream event filtering** - Option to exclude from history
2. **History size cap** - Keep last N messages
3. **Aggressive eviction** - Clear stream_events after message_stop

For debug purposes, keeping full history is valuable. Production may want trimming.

### Error Handling

All endpoints should return appropriate error codes:

- `404` - Session not found / no active process
- `408` - Timeout waiting for response (blocking mode)
- `410` - Process terminated during request
- `503` - Server overloaded / queue full

## Example Usage

### Testing rapid message submission

```bash
# Create a session
SESSION=$(curl -X POST http://localhost:3401/debug/sessions/create \
  -H "Content-Type: application/json" \
  -d '{"projectPath": "/home/user/project", "message": "hello", "blocking": true}' \
  | jq -r '.sessionId')

# Send 3 messages rapidly
curl -X POST "http://localhost:3401/debug/sessions/$SESSION/rapid" \
  -H "Content-Type: application/json" \
  -d '{"messages": ["msg1", "msg2", "msg3"], "blocking": true}'

# Compare SSE vs JSONL
curl "http://localhost:3401/debug/sessions/$SESSION/compare" | jq .

# Cleanup
curl -X DELETE "http://localhost:3401/debug/sessions/$SESSION"
```

### Investigating parent chain behavior

```bash
# Get session with full details
curl "http://localhost:3401/debug/sessions/$SESSION?includeStreamEvents=false" | jq .

# Check parent chain differences
curl "http://localhost:3401/debug/sessions/$SESSION/compare" \
  | jq '.comparison.parentUuidDiffs'
```

## Future Enhancements

1. **WebSocket endpoint** - Real-time streaming of events for live debugging
2. **Snapshot/restore** - Save session state for reproducible testing
3. **Mock mode** - Use mock SDK responses for faster iteration
4. **Diff visualization** - HTML endpoint showing SSE vs JSONL side-by-side
5. **Automated test suite** - Use debug API from integration tests

## Related Documentation

- `docs/research/claude-sdk-message-ids.md` - UUID consistency investigation
- `CLAUDE.md` - Maintenance server documentation
- `packages/server/src/supervisor/Process.ts` - Process state machine
- `packages/server/src/sdk/messageQueue.ts` - Message queuing implementation
