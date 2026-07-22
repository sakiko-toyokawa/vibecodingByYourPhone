# Claude Code Desktop (Anthropic)

**Website:** https://code.claude.com/docs/en/desktop
**Type:** Desktop app (Electron)
**Pricing:** Claude Pro ($20/mo), Max ($100-200/mo)

## Overview

Anthropic's official GUI for Claude Code. Provides visual interface over the CLI with local and remote execution options.

## Key Features

| Feature | Details |
|---------|---------|
| **Local execution** | Runs on your machine |
| **Remote execution** | Cloud sessions that persist when app closes |
| **Diff viewer** | File-by-file review with inline commenting |
| **Extended thinking** | Enabled by default (background, not displayed) |
| **Session management** | Visual session list |

## Architecture

Two execution modes:
1. **Local** — Runs on your machine
2. **Remote** — Runs on Anthropic's cloud infrastructure

Built on Electron (Chromium container). Uses Claude Agent SDK under the hood.

## Claude Cowork (January 2026)

Sandboxed agent for non-coders:
- Designate a folder for Claude to access
- Chat interface for instructions
- Same SDK as Claude Code, more approachable UX
- Available to Pro and Max subscribers

## Comparison to yepanywhere

### Claude Code Desktop has that we don't
- Remote execution (cloud, survives shutdown)
- Inline diff commenting
- Native app (Electron)
- First-party Anthropic support

### We have that Claude Code Desktop doesn't
- Multi-provider support (Codex, Gemini)
- Tiered inbox
- Fork/clone conversations
- Global activity stream
- Context usage tracking
- Bulk operations
- E2E encryption + relay for mobile access

### Similar
- Multi-session dashboard
- Diff review
- Permission approval
- Session persistence

## Target User

Claude users wanting GUI over CLI. Non-technical users via Cowork.

## Notes

Some criticism of Electron implementation being "clunky" with "non-standard UI." yepanywhere's web-based approach avoids native app UX issues while working everywhere.

## Sources

- [Claude Code Desktop Docs](https://code.claude.com/docs/en/desktop)
- [Claude Cowork Tutorial - DataCamp](https://www.datacamp.com/tutorial/claude-cowork-tutorial)
- [Simon Willison on Claude Cowork](https://simonwillison.net/2026/Jan/12/claude-cowork/)

## Last Updated

2026-02-03
