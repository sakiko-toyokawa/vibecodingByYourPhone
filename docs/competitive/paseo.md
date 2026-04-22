# Paseo

**Website:** https://paseo.sh
**GitHub:** https://github.com/getpaseo/paseo
**Type:** Daemon + mobile app + desktop + CLI
**Pricing:** Free, open source (AGPL-3.0)
**Install:** `npm i -g @getpaseo/cli && paseo`
**Author:** Mohamed Boudra (mo@faro.so)
**Version:** 0.1.28 (Mar 2026)
**Stars:** 215
**Local clone:** `~/code/reference/paseo`

## Overview

Mobile-first supervisor for AI coding agents. Same problem space as yepanywhere — one interface for monitoring and controlling local AI agents from phone, desktop, web, or CLI. Self-hosted, no external dependencies.

Based on a cursory evaluation of the cloned repo (not hands-on usage), here's what we found.

## Key Features

| Feature | Details |
|---------|---------|
| **Agent support** | Claude Code (SDK), Codex (AppServer), OpenCode (CLI) — 3 providers |
| **Voice** | On-device STT (Sherpa ONNX), cloud STT (Deepgram/OpenAI), TTS, turn detection, echo cancellation |
| **E2E encryption** | Curve25519 + XSalsa20-Poly1305 (NaCl/tweetnacl). Relay is zero-knowledge. QR code pairing |
| **Multi-host** | Connect to multiple daemons. `HostProfile` per server with direct TCP, Unix socket, named pipe, or relay. Routes: `/h/{serverId}/...`. CLI: `--host <host:port>` |
| **Multi-session** | Run multiple agents in parallel, 200-item timeline per agent |
| **Cross-device** | iOS, Android (Expo), desktop (Tauri, shipped), web app (Expo web → Cloudflare Pages), CLI |
| **Sub-agents** | MCP server appears to allow agents to spawn sub-agents with permission gates |
| **CLI** | Docker-style UX: `paseo run/ls/logs/wait/attach/send` |
| **Permission modes** | plan / default / full-access, switchable at runtime |
| **Terminal** | xterm emulation (with WebGL addon) + binary multiplexed WebSocket for PTY streaming |

## Architecture

Monorepo (npm workspaces), 779+ TypeScript files:

```
packages/
├── server/              — Daemon: agent lifecycle, WS server, relay transport
│   └── src/server/
│       ├── agent/
│       │   ├── providers/   — Claude (SDK), Codex (AppServer), OpenCode adapters
│       │   ├── agent-manager.ts — Lifecycle state machine
│       │   └── mcp-server.ts    — MCP server for sub-agents
│       ├── bootstrap.ts     — Daemon init
│       └── websocket-server.ts — Binary multiplexed WS
├── app/                 — Mobile/web client (Expo Router, React Native)
├── cli/                 — Commander.js CLI
├── relay/               — E2E encryption lib (NaCl/tweetnacl)
├── desktop/             — Tauri wrapper (macOS, Linux, Windows)
├── website/             — Marketing site (TanStack Router, Cloudflare Pages)
└── expo-two-way-audio/  — Native Expo module for realtime audio I/O
```

**Data dir:** `~/.paseo/` — agents as JSON per project/agent-id, project registry, workspace registry.

**WebSocket protocol:** Binary multiplexed — 1-byte channel ID + 1-byte flags + payload. Channel 0 = control (JSON), channel 1 = terminal (binary).

**Agent provider interface:** Common `AgentClient` with `run()`, `resume()`, `interrupt()`. Each provider maps tool calls to normalized `ToolCallDetail` type.

**Timeline model:** Append-only events with discriminated unions, epochs per run, 200-item history per agent.

## Tech Stack

- **TypeScript** (strict), React 19, React Native (Expo 54)
- **Node.js** + Express + ws (daemon)
- **Tauri** (desktop), **Expo** (mobile + web)
- **Claude Agent SDK** (0.2.11), OpenCode SDK, Codex AppServer
- **Sherpa ONNX** — on-device speech recognition (ML inference via ONNX Runtime)
- **Zod** — runtime validation, source of truth for types
- **pino** — structured logging
- **node-pty** — pseudo-terminal, **xterm** — terminal emulation

## Comparison to yepanywhere

### Paseo has that we don't (or don't yet)
- OpenCode provider support (3 providers)
- On-device speech recognition (Sherpa ONNX — no cloud dependency for STT)
- MCP sub-agent system (seems to allow agents to spawn sub-agents)
- Docker-style CLI (`paseo run/ls/logs/wait/attach/send`)
- TTS with turn detection and echo cancellation
- Native audio module (`expo-two-way-audio`)
- Shipped desktop app (Tauri — ours exists but isn't shipped yet)

### We have that Paseo doesn't seem to
- SRP authentication (they use QR-code-only trust, no password-based auth)
- Approval panel with view-details for large tool calls
- Device control — remote emulator page (adb-attached devices: screenshot, input, diagnostics)
- Provider filtering via env vars
- Multiple Claude profiles support
- Browser automation integration (claw-starter)
- Tiered inbox
- Fork/clone conversations
- Activity stream
- Session index cache with cross-machine dedup

### Similar
- E2E encrypted relay (both zero-knowledge, both NaCl/tweetnacl — nearly identical crypto)
- Multi-host — both save multiple servers and switch between them
- Web app — both have browser-based clients (we deploy to GitHub Pages at `/remote`, they deploy Expo web to Cloudflare Pages)
- Mobile-first design
- Self-hosted, no external dependencies
- WebSocket streaming
- Voice input
- Multi-session dashboard
- Open source

## Relay / E2E Encryption

Verified by reading their code (`packages/relay/src/crypto.ts`):

- Curve25519 DH key exchange (`nacl.box.before`) → shared secret → XSalsa20-Poly1305 (`nacl.box.after`)
- QR code pairing shares daemon's public key as trust anchor
- Handshake: client sends plaintext `e2ee_hello` with its public key, daemon replies `e2ee_ready`, then all messages encrypted
- Relay sees only IP addresses, timing, message sizes

Nearly identical crypto to yepanywhere — both use NaCl/tweetnacl with Curve25519 + XSalsa20-Poly1305. Main difference: we use SRP for password-based auth (relay never sees password), they use QR code pairing only.

## Development Practices

From their CLAUDE.md and docs (not verified in practice):
- TDD with vertical slices
- Real dependencies over mocks
- Collocated tests (`thing.ts` + `thing.test.ts`)
- vitest + Playwright

## Publishing & Distribution

- **npm:** 3 packages — `@getpaseo/server`, `@getpaseo/cli`, `@getpaseo/relay`
- **Desktop:** GitHub Actions → DMG (macOS), EXE (Windows), AppImage (Linux)
- **Mobile:** EAS cloud builds, APK on GitHub releases
- **Website:** Cloudflare Pages (paseo.sh)

## Activity

- ~1,708 commits (Oct 2025 – Mar 2026)
- Primary author: Mohamed Boudra, a few minor contributors
- Appears to release frequently
- Current version: 0.1.28

## Last Updated

2026-03-16
