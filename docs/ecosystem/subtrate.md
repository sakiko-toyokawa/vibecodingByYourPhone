# Subtrate

**Repo:** [github.com/Roasbeef/substrate](https://github.com/Roasbeef/substrate)
**Author:** Olaoluwa Osuntokun (Roasbeef) — co-creator of Lightning Network / lnd
**Language:** Go (43k LOC) + React/TypeScript (17k LOC)
**Status:** v0.2.0 shipped, daily-driver infrastructure
**Stars:** 7 (under the radar)

## What It Is

A command center for orchestrating multiple Claude Code agents. Gives agents a mail system to communicate, persistent identities that survive context compaction, and a hook system that keeps them alive and responsive. Paired with [claude-files](https://github.com/Roasbeef/claude-files) — Roasbeef's full Claude Code config with specialized sub-agents wired through Subtrate.

## How It Relates to Yep

**Complementary, not competitive.** Yep is human-to-agent supervision (mobile dashboard, approvals, session management). Subtrate is agent-to-agent coordination infrastructure (messaging bus, persistent identity, code review). Different subsystems that could theoretically compose.

## Architecture

```
Claude Code Agents (NobleLion, SilverWolf, CrimsonFox...)
    ↕ substrate CLI
Subtrate Daemon (substrated)
    ├── gRPC Server :10009
    ├── REST Gateway /api/v1/
    ├── WebSocket Hub (real-time)
    ├── Mail Service (Actor Pattern)
    ├── Review Service (FSM + Claude Agent SDK)
    ├── Local Queue (Store-and-Forward)
    └── SQLite (WAL + FTS5)
React Web UI :8080
```

3-tier message delivery fallback: gRPC → direct DB → local queue (store-and-forward when daemon offline).

## Key Features

### Mail System
- Agents get memorable codenames (e.g., `NobleLion@subtrate.e2e-testing`) — not UUIDs
- Inbox/outbox with threading, priority, deadlines, idempotency keys
- Per-recipient state tracking (read/unread, acked, starred, snoozed, archived)
- Full-text search via SQLite FTS5
- Pub/sub topics (direct/broadcast/queue types) with retention policies

### Persistent Agent Identity
- Identity survives Claude Code context compactions via hook system
- `SessionStart` hook → creates/retrieves identity
- `PreCompact` hook → saves state (consumer offsets for message dedup)
- Post-compaction → `identity restore` re-enters with same identity
- Stored in `~/.subtrate/identities/by-session` and `by-project`

### Keep-Alive (Stop Hook)
The key innovation: **agents don't exit when idle — they wait for work.**
- Stop hook always returns `{"decision": "block"}`
- Long-polls 9m30s for new messages
- Falls back to heartbeat mode if no mail
- Users can Ctrl+C to force exit
- Subagent variant: one-shot block if messages exist, then allows exit

### Code Review System
- FSM-based workflow: `new → pending_review → under_review → changes_requested → re_review → approved/rejected`
- Spawns **isolated** Claude Agent SDK reviewer sub-actors (sandboxed, read-only, no session persistence)
- 4 review types:
  - **full** (Sonnet, 10m) — bugs, logic, security, CLAUDE.md compliance
  - **security** (Opus, 15m) — injection, auth bypass, data exposure
  - **performance** (Sonnet, 10m) — N+1 queries, memory, allocations
  - **architecture** (Opus, 15m) — design, interfaces, testability
- Tiered 10-agent coordinator system in v0.2.0
- Structured issue tracking with severity, file path, line ranges

### Web UI
- React 19 + Zustand + TanStack Query + Tailwind v4
- Pages: Inbox, Agents Dashboard, Reviews, Tasks, Plans, Sessions, Search, Settings
- Real-time WebSocket updates
- Diff viewer with syntax highlighting (split/unified/fullscreen)
- 113 Playwright E2E test files
- Embedded in Go binary via `//go:embed` for production

### Hook Integration
Full Claude Code hook integration:
- **SessionStart** — heartbeat + inject pending unread messages
- **UserPromptSubmit** — silent heartbeat + check for mail
- **Stop** — keep-alive long-poll (main agents) or one-shot (subagents)
- **PreCompact** — save identity state for compaction survival
- **Notification** — send mail to User when approval needed
- **PostToolUse(Write)** — track plan file writes
- **PreToolUse(ExitPlanMode)** — submit plan for human review, block up to 9m for approval

## Tech Stack

**Backend (Go 1.25):**
- Actor system (home-grown, inspired by lnd/Erlang) for concurrent message processing
- gRPC + grpc-gateway (REST) + gorilla/websocket
- SQLite (WAL, FTS5, 16 tables, 8 migrations) via go-sqlite3
- sqlc for type-safe query generation
- Cobra CLI framework
- Claude Agent SDK Go (roasbeef/claude-agent-sdk-go) for reviewer agents
- lnd/fn/v2 Result[T] type for error handling
- MCP server integration (go-sdk)

**Frontend (React 19 + TypeScript):**
- Vite + bun
- Zustand (client state) + TanStack Query (server state)
- Headless UI + Tailwind v4
- React Router 7 with lazy-loaded pages
- Vitest + Playwright

## Design Patterns Worth Noting

- **Actor system with sealed interfaces** — unexported marker methods prevent external implementations
- **Thread/Review FSMs** — state objects + event handlers + outbox events for side effects
- **Storage abstraction layers** — domain types → sqlc store → generated queries → SQL
- **Heartbeat classification** — Active (<5m), Busy (active + session), Idle (5-30m), Offline (>30m)
- **Store-and-forward queue** — local queue with replay on reconnect, idempotency keys prevent duplicates

## Interesting Differences from mcp_agent_mail

| | Subtrate | mcp_agent_mail |
|---|---------|---------------|
| Protocol | gRPC + REST + WebSocket | MCP (HTTP) |
| Identity | Persistent codenames, survives compaction | Agent registration per project |
| Lifecycle | Keep-alive via Stop hook | Polling-based |
| Code review | Built-in FSM + Claude SDK reviewers | No |
| Web UI | Full React SPA | TUI (Rust version) |
| File coordination | Not built-in | Advisory file leases |
| Scale tested | Used daily by creator | 40-50 concurrent agents |
| Language | Go | Python (+ Rust rewrite) |

## Last Updated

2026-03-17
