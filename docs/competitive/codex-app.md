# Codex App (OpenAI)

**Website:** https://openai.com/codex/
**Type:** macOS app + cloud
**Launched:** February 2, 2026
**Pricing:** Included with ChatGPT plans (higher limits on paid)

## Overview

OpenAI's official interface for managing multiple coding agents. Combines local CLI with cloud-based sandboxed execution.

## Key Features

| Feature | Details |
|---------|---------|
| **Cloud sandboxes** | Tasks run in isolated containers, preloaded with your repo |
| **Parallel agents** | Multiple agents working simultaneously via worktrees |
| **Multi-agent management** | Dashboard for orchestrating agents across projects |
| **Skills system** | Beyond code: documentation, prototyping, code understanding |
| **Automations** | Background tasks: issue triage, CI/CD, alert monitoring |
| **GitHub integration** | Code Review in GitHub, PR proposals |
| **Diff review** | Review changes before merging |

## Architecture

Two execution modes:
1. **Local** — Runs on your machine via CLI
2. **Cloud** — Isolated OpenAI-managed containers

Cloud sandbox features:
- Internet access disabled during execution
- Only accesses code from connected GitHub repos
- Pre-installed dependencies via setup script
- System-level sandboxing (open source)

## Model

GPT-5-Codex — optimized for agentic coding. Available in:
- macOS app
- CLI
- IDE extension
- Cloud agent

## Comparison to yepanywhere

### Codex App has that we don't
- Cloud execution (survives computer shutdown)
- Automations (background triggers without user)
- Skills system (structured task types)
- GitHub Code Review integration
- Native macOS app

### We have that Codex App doesn't
- Multi-provider support (Claude, Gemini)
- Tiered inbox
- Fork/clone conversations
- Activity stream
- E2E encryption + relay
- Open source

### Similar
- Multi-session dashboard
- Parallel agent execution
- Diff review
- Permission approval

## Target User

Developers wanting cloud-offloaded coding tasks with GitHub integration. Enterprise teams using ChatGPT plans.

## Sources

- [OpenAI Codex](https://openai.com/codex/)
- [Codex Changelog](https://developers.openai.com/codex/changelog/)
- [Codex Cloud](https://developers.openai.com/codex/cloud/)
- [Codex Security](https://developers.openai.com/codex/security/)

## Last Updated

2026-02-03
