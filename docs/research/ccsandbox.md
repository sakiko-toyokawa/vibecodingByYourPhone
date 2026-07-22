# ccsandbox Competitive Analysis

**Repository:** https://github.com/hrntknr/ccsandbox
**Version analyzed:** 1.2.1
**Date:** 2026-02-03

## Overview

ccsandbox is a self-hosted web application that provides a Claude Code-like environment with **workspace isolation via devcontainers**. The key differentiator is that all Claude Code execution happens inside Docker containers rather than on the host system, providing security/compliance benefits.

The author's pitch: *"I kept thinking: 'I want to do quick Claude Code sessions while I'm out,' but SSH/mosh on a phone is… still a terminal. So I made something that feels more like Claude Web + my own workspace."*

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Express.js 5, Node.js 20+, TypeScript |
| Frontend | React 19, Vite 7, Tailwind CSS 4, xterm.js 6 |
| Claude Integration | `@anthropic-ai/claude-agent-sdk` ^0.2.29 |
| Terminal | `@lydell/node-pty`, xterm.js with fit/unicode11 addons |
| Container | Docker, `@devcontainers/cli` |
| Build | esbuild (server), Vite (web) |
| WebSocket | ws library |
| Auth | bcrypt password hashing, cookie-based tokens |
| Testing | Vitest, supertest |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Browser Client                      │
│  (React + xterm.js + Tailwind)                          │
└──────────────────────────┬──────────────────────────────┘
                           │ WebSocket
                           ▼
┌─────────────────────────────────────────────────────────┐
│                   Express Server                         │
│  ├── REST API (/api/*)                                  │
│  │   ├── /api/github - repo listing/cloning            │
│  │   ├── /api/sessions - CRUD, diff stats              │
│  │   ├── /api/config - settings (PAT, password, etc)   │
│  │   └── /api/sessions/:id/ports - port forwarding     │
│  └── WebSocket (/ws)                                    │
│      ├── terminal.handler.ts - tab/terminal mgmt       │
│      ├── session-create.handler.ts                      │
│      └── session-sync-manager.ts - multi-tab sync      │
└──────────────────────────┬──────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
┌─────────────────────────┐ ┌─────────────────────────────┐
│   Terminal Service       │ │    Claude Service           │
│   (node-pty → container) │ │   (Agent SDK → container)   │
└─────────────┬───────────┘ └──────────────┬──────────────┘
              │                             │
              └──────────┬──────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────┐
│                     Devcontainer                         │
│  ├── Cloned repository                                   │
│  ├── Claude Code feature auto-installed                 │
│  ├── Host .claude settings mounted (optional)           │
│  └── Git credentials injected via env/gitconfig         │
└─────────────────────────────────────────────────────────┘
```

**Data flow:** CLI → Server (Express + WebSocket) ↔ Web (React) → Services → Persistence (JSON: ~/.ccsandbox/)

## Key Features

### 1. Devcontainer-Based Sandboxing
- Uses `@devcontainers/cli` to spin up isolated containers per workspace
- Auto-injects the Claude Code devcontainer feature: `ghcr.io/anthropics/devcontainer-features/claude-code:1`
- Option to mount host `~/.claude.json` and `~/.claude/` into container
- Git credentials injected via `GITHUB_TOKEN` env var and custom gitconfig

### 2. Multi-Tab Terminal UI
- Multiple terminal tabs per session (both shell and Claude tabs)
- xterm.js with fit addon for responsive sizing
- Terminal resize sync across connected clients (uses minimum size)
- History replay on reconnect

### 3. Claude Agent SDK Integration
- Uses SDK's `query()` function with streaming input mode (async generator)
- Implements `canUseTool` callback for permission handling
- Supports all permission modes: default, acceptEdits, plan, bypassPermissions, delegate, dontAsk
- Real-time streaming of messages via WebSocket
- TodoList display from TodoWrite tool
- Extended thinking support (`maxThinkingTokens`)
- Image attachment support

### 4. Session Management
- Sessions tied to GitHub repos (clone via PAT)
- Session states: INITIALIZING, RUNNING, STOPPED, ERROR
- Persistent session metadata in JSON files
- Git diff view (stats + detail)

### 5. Multi-Client Sync
- Connection manager tracks clients in session "rooms"
- Tab state broadcast to all connected clients
- Real-time permission notifications
- Heartbeat/pong for connection health

### 6. Port Forwarding
- Forward ports from devcontainer to host
- Port detection service for auto-discovery
- Manual port forwarding via UI

### 7. Mobile-First Design
- Responsive layouts for desktop and mobile
- "Open a bookmark and start" experience

## Comparison with Yep Anywhere

| Aspect | ccsandbox | Yep Anywhere |
|--------|-----------|--------------|
| **Core concept** | Sandbox Claude in devcontainers | Supervisor for existing Claude sessions |
| **Isolation** | Docker containers per workspace | Runs on host (trusts user's machine) |
| **Session origin** | Creates new sessions in containers | Monitors existing SDK sessions |
| **Claude integration** | Agent SDK `query()` function | Agent SDK process management |
| **Terminal** | xterm.js → pty in container | Not primary focus |
| **Multi-session** | Yes, container per session | Yes, dashboard view |
| **Mobile** | Web UI, responsive | Web UI, push notifications |
| **Network access** | Direct (user manages firewall) | Tailscale recommended |
| **GitHub integration** | Deep (clone repos, PAT required) | None (works with any project) |
| **Setup** | Docker + devcontainer CLI required | Just npm install |
| **Auth** | Password-based | Password-based |

## Strengths

1. **Security model** - Devcontainer isolation prevents Claude from affecting host system
2. **GitHub workflow** - First-class repo cloning and credential management
3. **Feature complete** - Terminal, Claude chat, permissions, todos, git diff all integrated
4. **Clean codebase** - Well-structured TypeScript, comprehensive tests (16 test files)
5. **Modern stack** - React 19, Vite 7, Express 5, Tailwind 4
6. **SDK integration** - Uses official Agent SDK with all features (streaming, permissions, thinking)

## Weaknesses / Gaps

1. **Docker requirement** - Heavier setup compared to direct execution
2. **No push notifications** - Mobile experience requires polling/open tab
3. **No remote access built-in** - User must manage firewall/VPN themselves
4. **Single-server model** - No relay for accessing from different networks
5. **No existing session import** - Must create sessions through UI (can't watch external Claude sessions)
6. **GitHub-centric** - Requires GitHub PAT, no support for local-only projects without GitHub

## Interesting Implementation Details

### Wrapper Script Pattern
Creates shell scripts that wrap `devcontainer exec` to run Claude inside containers:
```typescript
// src/services/claude/devcontainer-wrapper.ts
export function createWrapper(scratchDir, tabId, options) {
  // Generates bash script that calls devcontainer exec claude
}
```

### SDK Usage Pattern
Uses streaming input mode with async generator:
```typescript
// src/services/claude/claude-session.ts
query({
  prompt: messageGenerator,  // AsyncGenerator<SDKUserMessage>
  options: {
    pathToClaudeCodeExecutable: this.wrapperPath,
    permissionMode: this._permissionMode,
    canUseTool: this.handlePermissionRequest.bind(this),
    includePartialMessages: true,
  },
});
```

### Multi-Tab Terminal Sizing
Syncs terminal to minimum size across all connected clients viewing same tab:
```typescript
// Calculates min(cols, rows) across all clients attached to a tab
// Resizes PTY to this minimum to ensure all clients can see full output
```

## Potential Learnings for Yep Anywhere

1. **Claude-specific features UI** - Their ClaudeChat components (TodoList, PermissionDialog, ThinkingBlock) show what users expect
2. **Multi-tab within session** - Users may want multiple Claude conversations per project
3. **Git diff integration** - Showing changes Claude made is valuable
4. **Extended thinking display** - ThinkingBlock component for displaying model reasoning
5. **Port forwarding** - For dev servers, useful when running in remote context

## Market Positioning

ccsandbox targets users who:
- Want Claude Code but are concerned about host security
- Work with GitHub repos and want integrated cloning
- Accept Docker overhead for isolation benefits
- Need multi-device access but can manage their own networking

Yep Anywhere targets users who:
- Already use Claude Code on a dev machine
- Want mobile supervision without changing workflow
- Need push notifications for approvals
- Want zero-friction remote access (Tailscale)
- Don't want to containerize their development

The products could be complementary - ccsandbox for "start fresh in sandbox" workflows, Yep Anywhere for "supervise existing work" workflows.
