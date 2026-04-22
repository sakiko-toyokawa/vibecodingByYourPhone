# Codexia

**GitHub:** [milisp/codexia](https://github.com/milisp/codexia)
**Website:** https://milisp.dev/codexia
**Type:** Tauri v2 desktop app + headless web server with mobile-responsive UI
**Pricing:** Free, open source (AGPL-3.0 + commercial license)
**Install:** Homebrew, GitHub releases, or `bun tauri dev`
**Stars:** 489 (as of 2026-03-14)

## Overview

Desktop workstation wrapping Codex CLI and Claude Code with an IDE-like UI, task scheduler, git worktree management, and a headless web server for remote control. Built with Tauri v2 (Rust backend) + React 19 frontend.

The same React frontend serves both desktop (Tauri webview) and headless mode (`codexia --web` on port 7420). The UI has mobile-responsive layouts throughout (`useIsMobile` hook at 768px breakpoint, responsive sidebar/panel behavior), so it functions as a phone-accessible web UI when running headless — not just a bare API.

## Who's Behind It

**Developer:** "milisp" — pseudonymous solo developer. No real name, no location, no company disclosed. Uses ProtonMail (milisp@proton.me). Twitter: [@lisp_mi](https://x.com/lisp_mi). Bio references "building a global ecosystem where AI lowers barriers."

**Team:** Effectively one person. 932 of 948 commits are from milisp. 6 other contributors total, all drive-by PRs (typo fixes, Windows bugs, translations). A `codexia-team` GitHub org exists but has 0 public repos — appears to be a placeholder.

**Funding:** None. No sponsors, no FUNDING.yml, no investors. In GitHub Discussions (Sep 2025), milisp wrote: "I'm preparing to grow this into a full company and ecosystem" but no evidence of follow-through. Commercial license available (email milisp@proton.me) but no evidence anyone has purchased it.

**Community:** Discord exists ([invite link](https://discord.gg/zAjtD4kf5K)), member count unknown. GitHub Discussions active but low volume (~10 threads). Several Chinese-language issues suggest a partly Chinese-speaking user base.

**Other projects by milisp:**
- [mcp-linker](https://github.com/milisp/mcp-linker) (296 stars) — MCP server config manager
- [awesome-claude-dxt](https://github.com/milisp/awesome-claude-dxt) (165 stars) — curated list of Claude Desktop Extensions
- [awesome-codex-cli](https://github.com/milisp/awesome-codex-cli) (58 stars) — curated list

The awesome lists serve as SEO funnels for Codexia discovery — smart growth strategy.

## Star Authenticity

489 stars over 7 months (since Aug 2025). **Appears mostly organic:**
- Even distribution over time (~2/day), no suspicious single-day spikes of 50+
- Spot-checked stargazers are real developers with established accounts
- One spike (~8/day for 3 days in Sep 2025) coincides with milisp posting engagement threads on GitHub Discussions

**Caution flag:** Only 2 watchers for 489 stars. Typical ratio would be higher — suggests many star-and-forget users from discovery/awesome lists rather than active usage.

**No Product Hunt, no HN front page, no major Reddit launch.** Growth is almost entirely GitHub discovery + awesome list traffic.

## Key Features

| Feature | Details |
|---------|---------|
| **Agent support** | Codex CLI (via app-server JSON-RPC), Claude Code (via claude-agent-sdk-rs) |
| **Desktop app** | Tauri v2 (Rust backend, small binary, no Electron bloat) |
| **Headless mode** | Axum web server on port 7420, serves full React UI + REST API + WebSocket. `codexia --web --host` for remote access |
| **Task scheduler** | Cron-based recurring jobs via tokio-cron-scheduler, SQLite persistence |
| **Git worktrees** | Create/manage worktrees via gix (Gitoxide), diff viewing, staging, commits |
| **IDE editor** | Ace editor with syntax highlighting, file tree, diff viewer |
| **Terminal** | xterm.js terminal emulator |
| **MCP integration** | TOML-based config for stdio/HTTP/SSE MCP servers |
| **Data preview** | PDF, Excel, CSV viewing |
| **i18n** | Multi-language support via i18next |
| **Usage dashboard** | Recharts-based analytics |

## Architecture

```
┌─────────────────────────────────────────┐
│  Tauri v2 Desktop  OR  Headless (Axum)  │
│  ┌────────────┐  ┌───────────────────┐  │
│  │ Codex CLI   │  │ Claude Code       │  │
│  │ app-server  │  │ claude-agent-     │  │
│  │ JSON-RPC    │  │ sdk-rs            │  │
│  └────────────┘  └───────────────────┘  │
│  ┌────────────┐  ┌───────────────────┐  │
│  │ Git (gix)  │  │ Task Scheduler    │  │
│  │ worktrees  │  │ tokio-cron        │  │
│  └────────────┘  └───────────────────┘  │
│  ┌────────────┐  ┌───────────────────┐  │
│  │ SQLite     │  │ MCP Server Mgmt   │  │
│  └────────────┘  └───────────────────┘  │
└─────────────────────────────────────────┘
         │ WebSocket + REST API │
┌─────────────────────────────────────────┐
│  React 19 + Zustand + shadcn/ui        │
│  File tree, editor, terminal, dashboard │
└─────────────────────────────────────────┘
```

**Feature flags** control build targets: `gui` (Tauri desktop) vs `web` (headless Axum). Can build headless-only binary without Tauri dependencies.

**Codebase size:** ~43k lines (5.9k Rust + 37k TypeScript). Lean for the feature set.

## Tech Stack

**Frontend:** React 19, TypeScript 5.8, Zustand, shadcn/ui (Radix + Tailwind 4), Vite 7, Biome linter, Bun package manager

**Backend (Rust):** Axum 0.8, Tokio, rusqlite (bundled SQLite), gix (Gitoxide), tokio-cron-scheduler, DashMap, serde

**Agent protocols:** codex-app-server-protocol (JSON-RPC over stdin/stdout), claude-agent-sdk-rs 0.6

## Security Model

**Local-first** — all data in SQLite on user's machine. No cloud, no accounts.

**Remote access weaknesses:**
- HTTP only (no TLS by default)
- `CorsLayer::new().allow_origin(Any)` — permissive CORS, any origin can hit the API
- No built-in authentication — relies entirely on network isolation
- No E2E encryption between client and server
- Recommendation: run behind Tailscale or authenticated reverse proxy

## Code Quality

- TypeScript strict mode enabled, Biome linter
- Rust code well-structured with clear module separation, async throughout
- **No test suite** — single WebSocket regression test, otherwise manual testing
- 30+ releases (v0.9.2 → v0.26.0) in 6 months — aggressive release cadence
- Clean commit messages with conventional prefixes (feat/fix/refactor/chore)

## Comparison to yepanywhere

### Codexia has that we don't
- Tauri desktop app (native feel, small binary)
- Built-in file tree + code editor + terminal
- Task scheduler (cron-based automation)
- Data file preview (PDF, Excel, CSV)
- MCP server management UI
- Git operations UI (diff, staging, commit)
- Usage analytics dashboard
- i18n (multi-language)

### We have that Codexia doesn't
- **Mobile-first design** (Codexia has mobile-responsive web UI via headless mode, but it's desktop-first with mobile as secondary)
- **E2E encryption** (NaCl/SRP — Codexia has no encryption)
- **Authentication** (SRP auth — Codexia has zero auth)
- **Server-owned processes** (sessions survive client disconnects)
- **Multi-agent providers** (Codex, Gemini, Claude — Codexia only does Codex + Claude Code)
- **Push notifications** (mobile alerts for approvals)
- **Fork/clone conversations**
- **Tiered inbox / activity stream**
- **Session persistence** (JSONL — Codexia uses SQLite)
- **Relay architecture** for remote access without port forwarding

### Similar
- React + TypeScript frontend
- Agent permission control (ask/always/never)
- WebSocket for real-time updates
- Git worktree support
- Open source

## Threat Assessment

**Low-medium.** Different positioning (desktop IDE wrapper vs mobile supervisor). Strengths:
- Good Codex CLI integration via app-server protocol (mirrors OpenAI's own approach)
- Broad feature surface (editor, terminal, scheduler, MCP)
- Active solo developer with 900+ commits

Weaknesses:
- Bus factor of 1 — project dies if milisp stops
- No auth/encryption makes remote mode a security liability
- No test suite — quality risk at this release cadence
- Headless web mode has mobile-responsive UI but no auth/encryption — unusable over the internet without a VPN
- AGPL-3.0 deters commercial adoption vs MIT
- No funding, no team, aspirational "company" talk with no follow-through

Most likely scenario: continues as a useful niche tool for Codex power users who want an IDE-like wrapper. The headless web mode gives it a mobile story, but the lack of auth/encryption means it requires Tailscale or similar — same gap we fill with SRP + E2E encryption.

## Last Updated

2026-03-14
