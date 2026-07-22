# Happy

**Website:** https://happy.engineering/
**Type:** Mobile app + CLI
**Pricing:** Free, open source (MIT)
**Install:** `npm i -g happy-coder && happy`

## Overview

Mobile-first Claude Code client with end-to-end encryption and voice commands. Focuses on security and voice-activated workflows.

## Key Features

| Feature | Details |
|---------|---------|
| **Agent support** | Claude Code, Codex |
| **E2E encryption** | Server can't read messages or code |
| **Voice commands** | Voice-to-action, not just transcription |
| **Multi-session** | Run multiple Claude instances in parallel |
| **Cross-device sync** | Real-time sync across mobile/desktop |
| **Push notifications** | Alerts when input needed |
| **Mobile apps** | iOS, Android, web |

## Architecture

Three components:
1. **CLI** - Runs locally, monitors Claude Code, encrypts data
2. **Mobile app** - Displays encrypted session data
3. **Relay server** - Routes encrypted messages, cannot decrypt

Privacy-focused: relay server is a dumb pipe.

## Comparison to yepanywhere

### Happy has that we don't
- Voice commands
- Native mobile apps (iOS/Android)

### We have that Happy doesn't
- Broader multi-provider support (Codex OSS, Gemini)
- Server-owned processes (theirs requires CLI running)
- Tiered inbox
- Fork/clone conversations
- Activity stream
- Context tracking
- Bulk operations
- Git worktree support (neither has, but we're planning)

### Similar
- E2E encryption + relay architecture
- Push notifications
- Multi-session dashboard
- Mobile-first design
- Open source

## Security Model

Both Happy and yepanywhere use E2E encryption with a relay:
- CLI/server encrypts before sending to relay
- Relay can't read content
- Client decrypts locally

Similar trust model — relay is a dumb pipe.

## Target User

Security-conscious developers who want mobile access with voice control.

## Last Updated

2026-02-03
