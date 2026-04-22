# emdash

**Website:** https://www.emdash.sh/
**Type:** Desktop application (Electron, open source, free)
**Repository:** [generalaction/emdash](https://github.com/generalaction/emdash)
**Funding:** YC W26

## Overview

Desktop application for orchestrating multiple AI coding agents in parallel. Positions itself as "your coding agent dashboard."

## Key Features

| Feature | Details |
|---------|---------|
| **Multi-agent support** | 21 agents: Claude Code, Codex, Gemini, Cursor, GitHub Copilot, Amp, etc. |
| **Git worktree isolation** | Each task runs in isolated worktree automatically |
| **Parallel execution** | Run competing agents on same task, compare results |
| **Built-in diff review** | Integrated code editing, diff review, commit management |
| **Kanban view** | Task board for tracking agent progress |
| **CLI auto-detection** | Automatically finds installed agent CLIs |
| **MCP integration** | Model Context Protocol support |

## Architecture Deep Dive (from source code review, 2026-02-25)

### It's Just a Terminal

**The critical insight: emdash doesn't parse agent output at all.** Every agent is spawned as a PTY (pseudo-terminal) process via `node-pty`, and raw terminal output is streamed to an `xterm.js` terminal pane in the UI. The agents themselves handle tool execution, file diffs, approvals, etc. — emdash is essentially a multi-tab terminal with a task board bolted on.

This means their "21 agent support" is just a registry of CLI flags. There's no structured understanding of messages, tool calls, file changes, or conversation flow. It's closer to iTerm2 with git worktree management than to a true agent supervisor.

### Declarative Provider Registry

All agents are defined in `src/shared/providers/registry.ts` as flat metadata objects:

```typescript
// Gemini's entire integration:
{
  id: 'gemini',
  name: 'Gemini',
  cli: 'gemini',
  autoApproveFlag: '--yolo',
  initialPromptFlag: '-i',
  resumeFlag: '--resume',
  icon: 'gemini.png',
  terminalOnly: true,
}
```

Each provider definition includes: CLI binary name, auto-approve flag, initial prompt flag, resume flag, version args, install command. No per-agent parsing code, adapters, or output schemas.

Adding a new agent = one registry entry + one env var in the allowlist. ~1 KB of code per agent.

### PTY Manager (`ptyManager.ts`, ~1,170 lines)

Three spawn modes:
1. **Shell-wrapped** — `{cli} {args}; exec {shell} -il` (user gets shell after agent exits)
2. **Direct** — faster, skips shell config loading
3. **SSH** — `ssh -tt` for remote servers

Arguments are composed from the registry flags via `buildProviderCliArgs()`. Environment uses a strict allowlist of ~50 vars (API keys, proxies, cloud config).

Session isolation only works for Claude (via `--session-id`); other agents including Gemini get no multi-session support.

### IPC & Rendering

- `ptyIpc.ts` (~600 lines) handles Electron IPC between main and renderer
- PTY output is buffered for 16ms before sending to reduce IPC overhead
- Renderer receives raw terminal bytes and feeds them to xterm.js
- No message parsing, no structured data extraction, no conversation model

### Provider Detection

`ConnectionsService.ts` checks each CLI at startup (`{cli} --version`), caches results to `provider-status-cache.json`. Regex extracts version numbers. Status is emitted to renderer for the UI.

### Custom Config

Users can override per-provider CLI paths, flags, env vars, and extra args in `settings.json`:

```json
{
  "providerConfigs": {
    "gemini": {
      "cli": "/opt/gemini-cli",
      "extraArgs": "--verbose",
      "env": { "GEMINI_API_KEY": "sk-xxx" }
    }
  }
}
```

## Gemini Integration Specifically

**There is none.** Gemini's "integration" is identical to every other agent — spawn the CLI with flags, stream raw terminal output. No Gemini SDK, no output parsing, no structured tool result extraction. The `terminalOnly: true` flag just means the UI shows a terminal pane instead of a structured chat view (which only Claude gets partial support for via session ID tracking).

This sidesteps the hard problem of Gemini integration (parsing its output format or using its SDK to get structured data) by not attempting it at all.

## Comparison to yepanywhere

### emdash has that we don't
- Multi-agent support (21 vs our 3-4 — but theirs is shallow, see above)
- Git worktree per task
- Kanban task tracking
- Compare outputs across agents
- Built-in diff review UI

### We have that emdash doesn't
- **Structured message parsing** — we actually understand conversation flow, tool calls, file diffs
- **Mobile-first design** — their xterm.js terminal is unusable on phones
- Server-owned processes (survives disconnects)
- Push notifications
- Tiered inbox system
- Conversation fork/clone
- Global activity stream
- Context usage tracking
- Bulk operations
- E2E encrypted relay for remote access

### Key Differentiator

emdash is a **terminal multiplexer with project management**. We are a **structured agent supervisor**. They can support 21 agents easily because they don't try to understand any of them. We support fewer agents but actually parse and present their output in a mobile-friendly structured UI. Their approach scales in breadth; ours scales in depth.

## Target User

Desktop power users who want to run multiple different agents in parallel and compare their work. Not useful for mobile supervision.

## Last Updated

2026-02-25
