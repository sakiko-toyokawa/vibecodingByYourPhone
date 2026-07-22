# Conductor

**Website:** https://www.conductor.build/
**Type:** macOS application
**Pricing:** Unknown

## Overview

macOS-native application for orchestrating Claude Code and Codex agents in parallel workspaces.

## Key Features

| Feature | Details |
|---------|---------|
| **Agent support** | Claude Code + Codex |
| **Git worktree isolation** | Each agent gets isolated workspace/branch |
| **Unified monitoring** | Dashboard showing all agent activities |
| **Merge workflow** | Review and merge agent changes |
| **Existing auth** | Uses your Claude Pro/Max subscription, existing API keys |

## Architecture

Three-step workflow:
1. **Repository setup** - Clones repos, manages locally
2. **Agent deployment** - Spins up isolated Claude Code instances
3. **Code review** - Visibility into activities, streamlined merge

All local, no cloud dependencies.

## Comparison to yepanywhere

### Conductor has that we don't
- Git worktree per agent
- Dedicated merge/review workflow
- macOS-native UX

### We have that Conductor doesn't
- Cross-platform (web-based)
- More agent support (Gemini, Codex OSS)
- Server-owned processes
- Push notifications
- Tiered inbox
- Fork/clone conversations
- Activity stream
- Context tracking
- Bulk operations

## Target User

macOS developers who want parallel Claude + Codex workflows with clean git isolation.

## Last Updated

2026-02-03
