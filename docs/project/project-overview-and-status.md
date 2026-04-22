# Yep Anywhere: Project Overview & Status

A polished web interface for managing Claude and Codex agents. Works great on mobile and desktop.

> For original vision documents and detailed design rationale, see `docs/archive/`.

## What It Is

Like the VS Code Claude extension, but:
- **Multi-provider** — Claude, Codex (including local models), Gemini
- **Mobile-first** — Touch-friendly UI, push notifications, works on phones
- **Multi-session** — See all projects at a glance, no window cycling
- **Server-owned** — Disconnect and reconnect without losing state

## Current State

### Working Features

**Core Loop**
- Server spawns and manages Claude Code SDK processes
- Real-time WebSocket streaming of agent messages to clients
- Message queuing while Claude is working
- Tool approval UI with approve/deny actions
- Permission modes: default, acceptEdits, plan, bypassPermissions

**Session Management**
- Multi-project dashboard showing all sessions
- Session persistence via SDK's jsonl files
- Resume sessions after process restart
- Detect external sessions (CLI, VS Code) as read-only
- Custom session titles and archive status

**Mobile Experience**
- PWA with installable web app support
- Push notifications for approval requests (VAPID, no Firebase)
- Approve/deny from lock screen
- WebSocket auto-reconnect with resume

**Agent Features**
- Subagent (Task tool) tracking with status display
- Model selection and extended thinking support
- File uploads via WebSocket
- Plan mode with approval workflow
- Voice input via browser speech API
- Session search and filtering

**Multi-Provider Support**
- Claude Code: Full support (primary provider, full tool transparency)
- Codex: Functional but limited transparency (edits are opaque, no granular tool events)
- Codex-OSS: Local models via shell commands (more transparent than cloud Codex)
- Gemini: Read-only mode (no editing tools, good for exploration/planning)

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Client (React PWA)                                         │
│  - SessionPage: real-time message display + tool approval   │
│  - Dashboard: multi-project session list                    │
│  - Push notification service worker                         │
└─────────────────────────┬───────────────────────────────────┘
                          │ WebSocket (streaming + actions)
┌─────────────────────────▼───────────────────────────────────┐
│  Server (Hono)                                              │
│  - Supervisor: manages process pool with worker queue       │
│  - Process: wraps Claude SDK, handles approvals/queue       │
│  - SessionReader: merges jsonl + live events via DAG        │
│  - PushNotifier: VAPID web push                             │
└─────────────────────────┬───────────────────────────────────┘
                          │ Claude Code SDK
┌─────────────────────────▼───────────────────────────────────┐
│  Claude Code CLI                                            │
│  - Runs in ~/.claude/projects/{projectId}/                  │
│  - Persists to session jsonl files                          │
└─────────────────────────────────────────────────────────────┘
```

### Known Gaps

| Area | Status | Notes |
|------|--------|-------|
| Multi-device push | Basic | Works, may need stale subscription cleanup |
| Process recovery | By design | Server restart halts processes; resume on next message |

## Tech Stack

- **Server**: Node.js, Hono, @anthropic-ai/claude-code SDK
- **Client**: React, Vite, React Router
- **Push**: web-push (VAPID protocol)
- **Linting**: Biome
- **Testing**: Vitest

## Project Structure

```
packages/
├── server/     # Hono backend
│   ├── supervisor/   # Process lifecycle (Supervisor, Process, WorkerQueue)
│   ├── routes/       # API endpoints
│   ├── sessions/     # Session file reading
│   └── push/         # Web push notifications
├── client/     # React frontend
│   ├── pages/        # SessionPage, NewSessionPage, etc.
│   ├── components/   # MessageInput, MessageList, ToolApprovalPanel
│   └── hooks/        # useSession, useConnection, usePushNotifications
└── shared/     # Shared types
```

## Competitive Position

| Tool | Multi-session | Desktop | Mobile | Push Notifications | Zero External Deps |
|------|---------------|---------|--------|-------------------|-------------------|
| Claude Code CLI | No | Yes | No | No | Yes |
| VS Code Extension | No | Yes | Partial* | No | Yes |
| **yep-anywhere** | Yes | Yes | Yes | Yes | Yes |

*VS Code Remote works but webview state is fragile.

## Future Directions

See dated docs in this folder (e.g., `2026-01-05-*.md`) for planned features.
