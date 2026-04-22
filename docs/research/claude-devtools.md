# claude-devtools Architecture Analysis

**GitHub:** https://github.com/matt1398/claude-devtools
**Website:** claude-dev.tools
**License:** MIT
**Version:** 0.1.0 (pre-1.0, ~120 commits, 4 contributors, created Feb 2026)

## What It Is

Desktop app that visualizes Claude Code session execution by reading raw JSONL session logs from `~/.claude/`. Tagline: "Terminal tells you nothing. This shows you everything."

**Key insight:** Claude Code's CLI hides execution details behind opaque summaries ("Read 3 files", "Edited 2 files"). claude-devtools reconstructs complete execution traces without modifying Claude Code itself. It works with sessions from terminal, IDE, or any wrapper tool — purely file-based, no API keys, no auth.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electron 40.3.0 |
| UI | React 18.3.1, Tailwind CSS 3.4.1 |
| State | Zustand 4.5.0 |
| HTTP server | Fastify 5.7.4 (standalone/Docker mode) |
| Build | electron-vite 2.3.0, Vite 5.4.2, TypeScript 5.9.3 |
| SSH | ssh2 1.17.0, ssh-config 5.0.4 |
| Virtual scroll | @tanstack/react-virtual 3.10.8 |
| Drag-and-drop | @dnd-kit/core 6.3.1 |
| Testing | Vitest 3.1.4, happy-dom 17.4.6 |
| Linting | ESLint 9.39.2, Prettier 3.8.1 |
| Package manager | pnpm 10.25.0 |

~311 TypeScript files, ~13,400 LOC.

## Architecture

### Process Model (Electron)

Three-process architecture:

1. **Main process** — Node.js. Manages app lifecycle, file system access, Fastify HTTP server, SSH connections, file watching. No UI code.
2. **Preload process** — Sandboxed bridge between main and renderer. Exposes limited API via `contextBridge`.
3. **Renderer process** — React app in BrowserWindow. Calls main process via preload IPC. State in Zustand, UI state persisted to IndexedDB.

### Communication

The main process exposes two parallel APIs:
- **IPC handlers** (`src/main/ipc/handlers.ts`) — for Electron-only clients
- **HTTP routes** (`src/main/http/`) — same business logic, callable from renderer (via preload→IPC), standalone HTTP server (Docker), or remote clients

This dual transport enables the same codebase to run as both an Electron app and a headless Docker server.

### Service Architecture

Uses a service locator pattern:

- `ServiceContextRegistry` holds all service instances (per local or SSH context)
- Each `ServiceContext` owns:
  - `ProjectScanner` — discovers projects from `~/.claude/projects/`
  - `SessionParser` — streams JSONL line-by-line with LRU caching
  - `ChunkBuilder` — groups messages into visualization chunks
  - `SubagentResolver` — links Task tool calls to subagent sessions
  - `FileSystemProvider` — abstract (local or SSH/SFTP)
  - Data caches (LRU for parsed sessions)

### Source Layout

```
src/
├── main/                    # Electron main process
│   ├── http/                # Fastify routes (projects, sessions, search, ssh, etc.)
│   ├── ipc/                 # Electron IPC handlers
│   ├── services/
│   │   ├── analysis/        # ChunkBuilder, SemanticStepExtractor, ToolResultExtractor
│   │   ├── discovery/       # ProjectScanner, SubagentResolver
│   │   ├── parsing/         # SessionParser, MessageClassifier
│   │   ├── infrastructure/  # ServiceContext, FileWatcher, ConfigManager, SshConnectionManager
│   │   └── error/           # ErrorDetector, TriggerMatcher, NotificationManager
│   └── types/               # Domain model (Project, Session, Chunk)
├── preload/                 # Sandboxed IPC bridge
├── renderer/                # React client
│   ├── store/               # Zustand (slices: chat, projects, sessions)
│   ├── components/
│   │   ├── chat/            # Session transcript view
│   │   │   ├── items/       # Message renderers
│   │   │   ├── viewers/     # CodeBlockViewer, DiffViewer, MarkdownViewer
│   │   │   └── SessionContextPanel/  # Context attribution UI
│   │   ├── sidebar/         # Project/session tree
│   │   ├── layout/          # TabbedLayout, PaneLayout
│   │   ├── settings/        # Config + notification triggers
│   │   └── search/          # Command palette (Cmd+K)
│   ├── hooks/
│   └── utils/               # contextTracker, displayItemBuilder, toolRendering
└── shared/                  # Types shared between main & renderer
```

## Core Features

### 1. Context Reconstruction (Primary Feature)

Reconstructs per-turn context window composition by tracking 7 token sources:

1. **CLAUDE.md** — Global, project, directory-level
2. **Mentioned files** — @mentions in user prompts
3. **Tool outputs** — Read, Bash, etc. result tokens
4. **Thinking text** — Extended thinking + output tokens
5. **Team coordination** — SendMessage, TaskCreate, etc.
6. **User message** — Prompt text per turn
7. **Compaction overhead** — System metadata during context compression

Compaction-aware: detects compression boundaries, measures token delta before/after, visualizes composition shift per phase.

### 2. Visualization Chunks

Groups messages into 4 chunk types instead of simple user↔assistant pairing:

- **UserChunk** — Real user message
- **AIChunk** — All assistant responses, tool calls, thinking until next user message
- **SystemChunk** — Command output
- **CompactChunk** — System metadata (filtered from view)

Each chunk includes metrics: duration, token usage, tool count. Rendered via virtual scrolling.

### 3. Subagent & Team Visualization

- Detects `Task` tool calls and resolves linked subagent JSONL files
- Renders expandable inline execution trees (agent → subagent → sub-subagent)
- Tracks team coordination: `TeamCreate`, `SendMessage`, `TaskUpdate`
- Color-coded teammate cards, distinct teammate vs subagent counts

### 4. Rich Tool Viewers

Where the CLI shows "Read 3 files", claude-devtools shows:
- Exact paths, syntax-highlighted content with line numbers
- Regex patterns, matching files, matched lines for search
- Inline diffs per file for edits

### 5. Notification Triggers

3 built-in triggers (all default-enabled):
- `.env` file access alert (content pattern match)
- Tool result error detection (`is_error: true`)
- High token usage threshold (default: 8K tokens/turn)

Custom triggers support regex matching on file_path, command, prompt, content, thinking fields. ReDoS protection validates patterns for exponential backtracking.

### 6. SSH Remote Sessions

Parses `~/.ssh/config`, supports agent forwarding + private keys. Opens SFTP channel to remote `~/.claude/`. Per-host `ServiceContext` with isolated caches. Renderer snapshots state to IndexedDB before context switch.

### 7. Multi-Pane Layout

Drag-and-drop tabs between panes (@dnd-kit). Split vertical/horizontal for side-by-side session comparison. State persisted to IndexedDB.

### 8. Cross-Session Search

Command palette (Cmd+K) searches all sessions in a project. Results show context snippets with highlighted keywords, navigate to exact message.

## Claude SDK Interaction

**Does NOT use the Claude SDK or API.** Purely reads JSONL files from `~/.claude/projects/{encoded-path}/*.jsonl`.

Pipeline:
1. `SessionParser` reads JSONL line-by-line (streaming)
2. `MessageClassifier` discriminates message types, filters noise (caveats, reminders, metadata)
3. `ToolResultExtractor` links tool calls to results
4. `SubagentResolver` finds linked subagent JSONL files
5. `ChunkBuilder` assembles visualization chunks with metrics

Token usage from SDK's `UsageMetadata` (input_tokens, output_tokens, cache_read/creation_tokens). CLAUDE.md and mention tokens estimated via tokenizer approximation.

## Deployment Modes

### Electron Desktop (Primary)
- macOS (ARM + Intel), Windows (NSIS), Linux (AppImage/deb/rpm/pacman)
- Auto-updater via GitHub releases
- `pnpm build && pnpm dist`

### Standalone HTTP Server (Docker/Headless)
- Fastify serves HTTP API + static renderer files
- `docker compose up` → http://localhost:3456
- Volume mount `~/.claude:ro` (read-only)
- Can run with `network_mode: none` for maximum isolation
- Env: `CLAUDE_ROOT`, `HOST`, `PORT`, `CORS_ORIGIN`

### Config & Data

- `~/.claude/claude-devtools-config.json` — Settings, triggers, pinned sessions
- `~/.claude/claude-devtools-notifications.json` — Last 100 detected errors
- No outbound network calls (zero telemetry)

## Notable Implementation Details

- **Path encoding/decoding:** Reverses Claude's `-Users-kgraehl-code-myapp` encoding for project discovery
- **Worktree grouping:** Detects source of git worktrees (Conductor, auto-claude, ccswitch, vibe-kanban, etc.) and groups by remote URL
- **Semantic step extraction:** Parses assistant thinking text to extract high-level reasoning steps as collapsible outlines
- **Waterfall chart data:** Computes timeline visualization of cumulative token consumption per message
- **Cursor-based pagination:** `{ timestamp, sessionId }` cursors for session lists, with light (filesystem-only) vs deep (parsed) metadata levels
- **File watching:** Debounced (100ms) monitoring of `~/.claude/projects/` triggers real-time sidebar updates and error detection

## Relevance to Yep Anywhere

### Complementary, Not Competitive

claude-devtools is a **read-only post-hoc analysis tool** — it visualizes sessions that already happened. Yep Anywhere is a **real-time supervisor** — it drives Claude Code sessions and handles permissions, notifications, and input.

The tools serve different use cases:
- **yepanywhere:** "I need to start/monitor/approve Claude sessions from my phone"
- **claude-devtools:** "A session finished (or failed); I want to understand what happened"

### Feature Ideas Worth Considering

1. **Per-turn context attribution** — Their 7-category token breakdown is more granular than our context usage tracking. Could inform our real-time context display.
2. **Compaction phase visualization** — Showing when/how context was compressed helps users understand session behavior.
3. **Subagent execution trees** — Their expandable tree view for Task-spawned agents is more detailed than our subagent rendering.
4. **Semantic step extraction** — Mining assistant thinking for high-level steps could improve our session summaries.
5. **Notification triggers with regex** — Their custom trigger system with ReDoS protection is well-designed.

### Potential Integration

Since claude-devtools reads from `~/.claude/` (same files we use), there's no conflict in running both. A user could supervise sessions with yepanywhere and analyze completed sessions with claude-devtools.

## Last Updated

2026-02-19
