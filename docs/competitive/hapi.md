# HAPI Architecture Research

Research notes on HAPI (https://github.com/anthropics/hapi), a local-first platform for running AI coding agents with remote control. Very similar to yepanywhere in purpose.

## Overview

HAPI is a decentralized alternative to centralized agent platforms. Each user runs their own "hub" (server). Data stays on the user's machine.

**Key similarities to yepanywhere:**
- Mobile-first supervision for AI coding agents
- Multi-provider support (Claude, Codex, Gemini)
- Real-time streaming to web UI
- Permission approval from phone
- Session persistence

**Key differences:**
- CLI-wrapper architecture (vs our server-owned processes)
- Socket.IO for CLI↔Hub (vs our direct SDK usage)
- SQLite persistence (vs our JSONL files)
- Multi-machine as first-class concept

## Architecture

### Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│  User's Machine                                             │
│                                                             │
│  ┌─────────────┐     Socket.IO      ┌─────────────┐        │
│  │  HAPI CLI   │ ←───────────────→  │  HAPI Hub   │        │
│  │  (wrapper)  │                    │  (server)   │        │
│  └─────────────┘                    └─────────────┘        │
│        │                                   │                │
│        │ stdin/stdout                      │ SSE + REST    │
│        ▼                                   ▼                │
│  ┌─────────────┐                    ┌─────────────┐        │
│  │ Claude CLI  │                    │   Web App   │        │
│  │ (subprocess)│                    │   (React)   │        │
│  └─────────────┘                    └─────────────┘        │
└─────────────────────────────────────────────────────────────┘
```

### Communication Layers

| Layer | Protocol | Direction | Purpose |
|-------|----------|-----------|---------|
| CLI ↔ Hub | Socket.IO | Bidirectional | Agent events, permissions, RPC |
| Hub → Web | SSE | Server → Client | Live message/session updates |
| Web → Hub | REST API | Client → Server | User actions (send message, approve) |
| CLI ↔ Agent | JSON over stdin/stdout | Bidirectional | Agent control |

### How CLI Communicates with Agents

#### Claude
HAPI spawns Claude CLI with JSON streaming flags and communicates via stdin/stdout:

```typescript
// cli/src/claude/sdk/query.ts
const child = spawn(spawnCommand, [
    '--output-format', 'stream-json',  // Claude outputs JSON per line
    '--input-format', 'stream-json',   // Claude accepts JSON input
    '--permission-prompt-tool', 'stdio' // Permission requests via JSON
], { stdio: ['pipe', 'pipe', 'pipe'] })

// Read stdout line-by-line
const rl = createInterface({ input: this.childStdout })
for await (const line of rl) {
    const message = JSON.parse(line) as SDKMessage
    // Forward to hub via Socket.IO
}
```

#### Codex
Two modes:

1. **Local mode**: Simple CLI spawn, takes over terminal
   ```typescript
   spawn('codex', args)
   ```

2. **Remote mode**: JSON-RPC via `codex app-server`
   ```typescript
   this.process = spawn('codex', ['app-server'], {
       stdio: ['pipe', 'pipe', 'pipe'],
   });
   // JSON-RPC protocol
   await this.sendRequest('thread/start', params);
   await this.sendRequest('turn/start', { threadId, userMessage });
   ```

### Comparison: CLI-Wrapper vs Server-Owned

| Aspect | HAPI (CLI-Wrapper) | Yepanywhere (Server-Owned) |
|--------|-------------------|---------------------------|
| Process ownership | CLI owns agent, must stay running | Server owns agent process |
| Disconnect handling | CLI disconnect = agent stops | Client disconnect = agent continues |
| SDK usage | Reimplements JSON protocol | Uses official SDK directly |
| Flexibility | More control over protocol | Tied to SDK abstractions |
| Maintenance | Must track CLI protocol changes | SDK updates automatically |

## Monorepo Structure

```
hapi/
├── cli/         - CLI binary wrapping AI agents
├── hub/         - Central coordination server (HTTP, Socket.IO, SQLite)
├── web/         - React PWA for remote control
├── shared/      - Shared types and schemas
├── website/     - Marketing landing page
└── docs/        - VitePress documentation
```

## Feature Comparison

### Full Feature Matrix

| Feature | HAPI | Yepanywhere | Notes |
|---------|------|-------------|-------|
| **Code Diff Viewing** | ✅ Full | ✅ Full | Both have modal + inline views |
| **Subagent/Task Inspection** | ✅ Hierarchical tree | ✅ Lazy-load JSONL | HAPI shows tree; YA loads full nested content |
| **Conversation Cloning** | ❌ No | ✅ Yes | YA has clone in session menu |
| **Conversation Forking** | ❌ No | ✅ Yes | YA can fork from any message |
| **Archive/Star** | ✅ Yes | ✅ Yes | Both have full session management |
| **Rename Sessions** | ✅ Dialog | ✅ Inline edit | Different UX patterns |
| **File Browsing** | ✅ Git-aware page | ⚠️ Via FileViewer | HAPI has dedicated files page |
| **Terminal Access** | ✅ Full xterm.js | ❌ No | HAPI has dedicated terminal page |
| **Permission Approval** | ✅ Yes | ✅ Yes | Both have approval UI |
| **Permission Modes** | ✅ Yes | ✅ Yes | Both support mode switching |
| **Todo List Display** | ✅ Yes | ✅ Yes | Similar implementations |
| **Thinking/Reasoning** | ✅ Collapsible | ✅ Collapsible | Both auto-expand while streaming |
| **Multi-Provider** | ✅ Claude/Codex/Gemini/OpenCode | ✅ Claude/Codex/Gemini | HAPI has OpenCode too |
| **Multi-Machine** | ✅ Machine selector | ✅ Remote executors + Relay | Different mechanisms |
| **Worktree Creation** | ✅ Yes | ❌ No | HAPI can create git worktrees |
| **Inbox/Triage** | ❌ No | ✅ Tiered inbox | YA has sophisticated inbox system |
| **Activity Stream** | ❌ No | ✅ Global activity | YA has cross-session activity |
| **Bulk Actions** | ❌ No | ✅ Multi-select | YA has bulk archive/star/delete |
| **Context Usage** | ❌ Not visible | ✅ Real-time % | YA shows token usage |
| **Draft Persistence** | ❌ No | ✅ Yes | YA auto-saves drafts |
| **YOLO Mode** | ✅ Toggle in new session | ✅ Via permission mode | Same concept, different UX |

### Features HAPI Has That We Don't

| Feature | Description | Potential Value |
|---------|-------------|-----------------|
| **Terminal Page** | Full xterm.js terminal at `/sessions/$id/terminal` | High - useful for debugging |
| **File Browser** | Dedicated page at `/sessions/$id/files` with git staging | Medium - we have inline FileViewer |
| **Git Worktree Creation** | Create isolated worktrees per session | Medium - nice for parallel work |
| **Hierarchical Task Tree** | Shows pending children in collapsible tree | Low - we lazy-load nested content |

### Features We Have That HAPI Doesn't

| Feature | Description |
|---------|-------------|
| **Tiered Inbox** | Needs Attention → Active → Recent → Unread |
| **Conversation Fork/Clone** | Fork from any message point |
| **Global Activity Stream** | Cross-session activity feed |
| **Context Usage Tracking** | Real-time token percentage |
| **Bulk Operations** | Multi-select archive/star/delete |
| **Draft Persistence** | Auto-save messages, feedback, answers |

### Feature Parity

Both have:
- Code diff viewing (modal + inline)
- Subagent/task inspection
- Session archive/star/rename
- Permission approval UI
- Permission mode switching
- Todo list display
- Thinking/reasoning display (collapsible)
- Multi-provider (Claude, Codex, Gemini)
- Multi-machine support
- Mobile-responsive UI

## Interesting Patterns

### Versioned Metadata Updates

HAPI uses optimistic concurrency for concurrent edits:

```typescript
socket.emit('update-metadata', {
    sid,
    expectedVersion: 5,        // Last known version
    metadata: { name: 'new' }
}, callback)

// Hub rejects if version mismatch
if (session.metadataVersion !== expectedVersion) {
    callback({ result: 'version-mismatch', ... })
}
```

Could adopt for multi-tab editing scenarios.

### Namespace-based Multi-tenancy

Simple user isolation via token prefix:

```typescript
// Token format: CLI_API_TOKEN:namespace
// All queries filtered by namespace
WHERE namespace = ?
```

Simpler than full user tables if we ever need multi-user.

### RPC Gateway

CLI registers tool handlers, hub routes requests:

```typescript
socket.emit('rpc-register', { method: 'read_file' })
// Hub can now request file reads from CLI
```

Enables "browse files on CLI machine from web" without hub filesystem access.

### Visibility Tracking

Skip SSE to hidden browser tabs:

```typescript
POST /api/visibility { subscriptionId, visibility: "visible" }
// Hub skips sending to hidden tabs
```

Battery optimization for mobile.

## Potential Learnings to Adopt

1. **Terminal page** - Full terminal access would help with debugging external sessions
2. **File browser page** - Dedicated exploration vs inline viewing
3. **Versioned updates** - Prevent concurrent edit conflicts
4. **Visibility optimization** - Skip updates to hidden tabs

## Tech Stack

- **Language**: TypeScript (strict)
- **Build**: Bun + Vite
- **Runtime**: Bun
- **Validation**: Zod schemas
- **Database**: SQLite (better-sqlite3)
- **Real-time**: Socket.IO + SSE
- **Deployment**: Single binary via Bun

## References

- Repository: https://github.com/anthropics/hapi (assumed, not verified)
- Local path: ~/code/research/hapi
