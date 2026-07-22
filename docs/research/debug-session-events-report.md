# Debug Session Event Report

**Session ID:** `594a527c-a604-4f5f-9f56-22f8db7e8b41`
**Project:** `/home/kgraehl/code/yepanywhere`
**Prompt:** "What is 2+2? Answer briefly."
**Response:** "4"
**Model:** `claude-opus-4-5-20251101`

---

## Data Collection Methods

| Source | Endpoint/Path | What It Provides |
|--------|---------------|------------------|
| **Debug API - Create** | `POST /debug/sessions/create` | Creates session, returns messages |
| **Debug API - Detail** | `GET /debug/sessions/:id?includeStreamEvents=true` | In-memory SSE events (all types) |
| **Debug API - Compare** | `GET /debug/sessions/:id/compare` | SSE vs JSONL diff |
| **JSONL File** | `~/.claude/projects/-home-kgraehl-code-yepanywhere/{session}.jsonl` | Persisted messages on disk |
| **SDK Raw Log** | `~/.yep-anywhere/logs/sdk-raw.jsonl` | All SDK messages with timestamps |

---

## SSE/Streaming Events (In-Memory)

**Total: 10 events** (1 user, 1 assistant, 1 system, 6 stream_events, 1 result)

| # | UUID | Type | Content |
|---|------|------|---------|
| 1 | `94c1c05b-...` | `user` | "What is 2+2? Answer briefly." |
| 2 | `fe329187-...` | `system` | Init (model, tools, cwd, etc.) |
| 3 | `08b8f92a-...` | `stream_event` | `message_start` |
| 4 | `ad0d3cbb-...` | `stream_event` | `content_block_start` |
| 5 | `8de43f1c-...` | `stream_event` | `content_block_delta` (text: "4") |
| 6 | `4a2eadbf-...` | `assistant` | "4" (complete message) |
| 7 | `746af7dd-...` | `stream_event` | `content_block_stop` |
| 8 | `8643ddc4-...` | `stream_event` | `message_delta` (stop_reason: end_turn) |
| 9 | `d68f6751-...` | `stream_event` | `message_stop` |
| 10 | `922bfef0-...` | `result` | Success, cost: $0.027, duration: 3234ms |

---

## JSONL Persisted Events (On-Disk)

**Total: 3 lines** (only durable user/assistant messages)

```jsonl
{"type":"queue-operation","operation":"dequeue","timestamp":"2026-01-05T18:06:56.908Z",...}
{"type":"user","uuid":"94c1c05b-...","message":{"content":"What is 2+2? Answer briefly."},...}
{"type":"assistant","uuid":"4a2eadbf-...","message":{"content":[{"type":"text","text":"4"}]},...}
```

**Key fields in JSONL:**
- `parentUuid` - DAG linkage (assistant → user)
- `sessionId`, `version`, `gitBranch` - Context
- `requestId` - Anthropic API request ID
- `timestamp` - When persisted

---

## SSE vs JSONL Comparison

| Metric | SSE | JSONL |
|--------|-----|-------|
| Total user/assistant | 2 | 2 |
| User messages | 1 | 1 |
| Assistant messages | 1 | 1 |
| UUIDs matching | 2/2 | |
| In SSE only | 0 | |
| In JSONL only | 0 | |

**Parent UUID tracking:** JSONL has `parentUuid` linking assistant→user; SSE doesn't track this in preview.

---

## SDK Raw Log (Full Detail)

From `~/.yep-anywhere/logs/sdk-raw.jsonl`:

| Timestamp (ms) | Type | Details |
|----------------|------|---------|
| 1767636416925 | `system/init` | Tools: 18, Model: opus, Mode: default |
| 1767636419748 | `stream_event` | `message_start` with usage stats |
| 1767636419835 | `stream_event` | `content_block_start` |
| 1767636419838 | `stream_event` | `content_block_delta` text="4" |
| 1767636420053 | `assistant` | Complete message |
| 1767636420053 | `stream_event` | `content_block_stop` |
| 1767636420127 | `stream_event` | `message_delta` stop_reason=end_turn |
| 1767636420136 | `stream_event` | `message_stop` |
| 1767636420145 | `result` | Success, total_cost=$0.027 |

---

## Summary

| Storage | Events | Purpose |
|---------|--------|---------|
| **In-Memory (SSE)** | All 10 | Real-time streaming to clients |
| **JSONL (Disk)** | 3 | Durable session history (user/assistant only) |
| **SDK Raw Log** | 9 | Debug/analysis (all SDK events with timing) |

**Stream events are ephemeral** - only user/assistant messages persist to JSONL. The SDK raw log captures everything for debugging.
