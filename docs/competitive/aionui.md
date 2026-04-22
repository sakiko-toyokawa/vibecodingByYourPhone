# AionUi

**GitHub:** [iOfficeAI/AionUi](https://github.com/iOfficeAI/AionUi)
**Stars:** ~16,800 | **Commits:** 2,550 | **License:** Apache 2.0
**Status:** Active (v1.8.15, Feb 2026)

## Overview

Electron desktop app that wraps 17 ACP-compatible CLI agents (Claude, Codex, Gemini, Goose, Qwen, and more) behind a unified interface. Extends to mobile via Telegram/Lark/DingTalk bots and a browser-accessible WebUI. Built-in cron scheduling for unattended agent tasks.

Positioned as an "AI desktop workspace" rather than a mobile-first supervisor. Strong presence in the Chinese developer ecosystem (Lark/DingTalk integrations, i18n for zh-CN/zh-TW/ja/ko).

## Key Features

| Feature | Details |
|---------|---------|
| **17 ACP backends** | Claude, Codex, Gemini, Goose, Qwen, CodeBuddy, iFlow, Auggie, Kimi, OpenCode, Droid, Copilot, Qoder, Vibe, OpenClaw, Nanobot, plus custom agents |
| **Messaging platform bots** | Telegram (inline keyboards), Lark (interactive cards), DingTalk (AI Cards) with QR-code pairing auth |
| **WebUI mode** | Express server with JWT + bcrypt + CSRF + rate limiting for browser access |
| **Cron scheduling** | Natural language cron with auto-approval mode, power management (prevents sleep during jobs) |
| **MCP management UI** | Per-backend MCP server detection, enable/disable, test connection |
| **File preview** | PDF, Word, Excel, PPT, images, code — rendered inline with real-time tracking |
| **i18n** | English, Chinese (Simplified/Traditional), Japanese, Korean |
| **12 pre-built assistants** | Document generation, data analysis, image editing, web search |
| **20+ LLM API providers** | Direct API access (Anthropic, OpenAI, Google, DeepSeek, Ollama, AWS Bedrock, etc.) |

## Architecture

**Tech stack:** Electron 37 + React 19 + TypeScript 5.8 + better-sqlite3 + Express 5

```
Electron App
├── Main Process
│   ├── SQLite database (conversations, messages, channels, cron)
│   ├── WorkerManage → Electron utilityProcess per agent
│   ├── ChannelManager → Telegram/Lark/DingTalk bots
│   ├── CronService → scheduled tasks with CronBusyGuard mutex
│   └── Express WebUI server (JWT auth, WebSocket streaming)
├── Renderer Process
│   └── React 19 UI (Arco Design, Monaco Editor, React Virtuoso)
└── Worker Processes (one per agent)
    └── AcpConnection → child_process.spawn() → CLI subprocess
```

### Agent Spawning — The Zed Bridge Pattern

AionUi does **not** use official CLIs directly for Claude or Codex. Instead it uses Zed's ACP bridge packages:

| Agent | Spawn command | Notes |
|-------|---------------|-------|
| **Claude** | `npx @zed-industries/claude-agent-acp@0.18.0` | Zed's ACP bridge, NOT `claude acp` |
| **Codex** | `npx @zed-industries/codex-acp@0.9.4` | Zed's ACP bridge, detects `mcp serve` vs `mcp-server` |
| **Gemini** | Built-in `@office-ai/aioncli-core` | Their own fork — calls Gemini API directly, no CLI spawn |
| **Others** | `goose acp`, `qwen --acp`, `opencode acp`, etc. | Native CLI with ACP flags |

Key detail: Gemini uses no CLI at all. They forked the Gemini agent into their app and call `@google/genai` directly, bypassing `--experimental-acp` entirely.

### ACP Protocol (JSON-RPC 2.0 over stdio)

Methods: `initialize`, `session/new`, `session/prompt`, `session/set_mode`, `session/set_model`, `session/update` (streaming), `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`.

Timeouts: 60s for most requests, 300s for `session/prompt`, reset on streaming chunks.

### Messaging Platform Integration (Channels)

Plugin architecture with abstract `BasePlugin` lifecycle (`created → initializing → ready → running → stopped`):

- **Telegram** (grammY): Long polling, inline keyboard buttons for agent switching/session control/response actions
- **Lark** (@larksuiteoapi/node-sdk): WebSocket, interactive cards (only editable message format)
- **DingTalk** (dingtalk-stream): WebSocket stream, AI Card with streaming updates, 3-level fallback (AI Card → sessionWebhook → Open API)

**Important caveat:** Channel conversations use `yoloMode` (auto-approve all tool calls). The inline keyboards are for agent switching, session management, and response actions — not per-tool-call approval. This is a fundamentally different model from mobile approval-first supervisors.

Authorization uses a QR-code pairing flow: user sends first message → 6-digit code (10 min TTL) → local user approves in AionUi settings → creates `assistant_users` record.

Per-chat session isolation via composite key `userId:chatId` prevents context leakage across group chats.

### Cron Scheduling

- `croner` library parses cron expressions
- `CronBusyGuard` mutex prevents concurrent cron + user input on same conversation
- Agents spawned with `yoloMode: true` for unattended execution
- `powerSaveBlocker` prevents system sleep during active cron jobs
- Retry up to 3 times with backoff on failure

### Security Model

- **No telemetry, no analytics, no phone home** — only checks GitHub releases API for updates
- API keys stored in encrypted electron-store (desktop) or bcrypt-hashed SQLite (WebUI)
- WebUI: JWT (7-day expiry) + token blacklist on logout + CSRF + rate limiting (5 auth attempts/15min, 60 API requests/min)
- Channel credentials: Base64 encoded (not true encryption)
- Process isolation: Each agent runs in separate Electron utilityProcess
- Shell security: `child_process.spawn()` (no shell interpretation), clean env (removes NODE_OPTIONS, npm_*)
- No E2E encryption for WebUI or channel traffic

## Comparison to yepanywhere

### What They Have That We Don't

- **Messaging platform as mobile proxy** — Telegram/Lark/DingTalk bots instead of custom mobile UI
- **Cron scheduling** — unattended agent tasks with auto-approval
- **17 ACP backends** — broadest agent support via unified ACP protocol
- **File preview system** — PDF/Word/Excel/PPT rendered inline
- **MCP management UI** — per-backend server detection and control
- **i18n** — 5 languages
- **Built-in LLM API access** — 20+ providers without needing CLI tools installed

### What We Have That They Don't

- **Mobile-first UX** — they're desktop-first; mobile is WebUI-in-browser or Telegram
- **E2E encryption + relay** — their WebUI has no encryption; channel traffic is plaintext
- **Server-owned processes** — our processes survive client disconnects; their Electron app must stay running
- **Tiered inbox** — Needs Attention → Active → Recent → Unread
- **Fork/clone conversations** — from any message point
- **Bulk operations** — multi-select archive/star/delete
- **Draft persistence** — auto-save messages
- **Lightweight deployment** — `npm install` vs downloading an Electron app
- **Per-tool-call mobile approval** — their channels auto-approve everything (yoloMode)

### Subscription Auth: A Cost Disadvantage for AionUi

Anthropic's [Jan 2026 crackdown](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/) banned third-party tools that spoof client identity to use subscription OAuth tokens. AionUi's `claude-agent-acp` bridge requires an API key (no OAuth support), so users must pay per-token — significantly more expensive than a $200/month Max subscription.

Yepanywhere uses the official Agent SDK with the user's own subscription credentials. Anthropic [confirmed](https://x.com/trq212/status/2024212378402095389) that individual use of the Agent SDK with Max subscriptions is permitted. This gives us a meaningful cost advantage for Claude users.

For Gemini, AionUi calls the `@google/genai` API directly (API key required). Google's Gemini CLI free tier uses Google OAuth with rate limits; AionUi bypasses this entirely. For Codex, both approaches use API keys — no subscription model exists.

### Different Approach, Same Space

AionUi wraps agents behind ACP and extends reach via messaging platforms. We use the Agent SDK directly for Claude and provide a purpose-built mobile supervision UI. Their approach trades approval granularity for reach (Telegram = instant mobile access for billions of users). Ours trades reach for control (custom UI = better approval UX, E2E encryption, tiered inbox).

## Interesting Patterns Worth Studying

1. **Session-level approval cache (ApprovalStore)** — caches "allow always" decisions per (kind + tool + path) within a session; auto-approves identical operations without re-prompting
2. **StreamingMessageBuffer** — batches SQLite writes during streaming to avoid per-token I/O
3. **CronBusyGuard** — mutex preventing cron jobs and user input from colliding on same conversation
4. **Unified message protocol** — `IUnifiedIncomingMessage`/`IUnifiedOutgoingMessage` abstracts away Telegram vs Lark vs DingTalk differences
5. **Plugin lifecycle state machine** — `created → initializing → ready → running → stopped` with error transitions from any state
6. **npm cache recovery** — two-phase npx spawn: `--prefer-offline` first, then clean cache + retry without for version upgrades
7. **Dual broadcast** — agent events go to both desktop UI (via IPC) and messaging platforms (via EventBus) simultaneously

## Target User

Developers who want a single desktop app to manage multiple AI coding agents, with the ability to interact via their preferred messaging platform (especially in Chinese enterprise environments using Lark/DingTalk). Not optimized for mobile-first supervision or security-conscious remote access.

## Last Updated

2026-02-22
