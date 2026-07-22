# Subscription-Plan Access: Approaches Compared

Date: 2026-02-25

## The Problem

AI coding agents are expensive via API keys ($15-75/MTok for frontier models). Claude Pro ($20/mo), Max ($100-200/mo), and ChatGPT Plus/Pro offer dramatically better economics for heavy users. But these subscription plans are gated behind official CLI tools and OAuth flows — there's no documented "subscription API" you can call with a bearer token.

Every project in this space has to make a choice: how do you give users access to their subscription plans programmatically?

## The Spectrum

From least to most structured:

```
Raw Terminal ←————————————————————————————————→ Full API Wrapper
   emdash        Yep Anywhere       pi-mono         Vercel AI
   (PTY)         (SDK process)    (reverse OAuth)   (API keys only)
```

## Approach 1: Raw Terminal Passthrough (emdash)

**Project:** [emdash](https://github.com/generalaction/emdash) (YC W26)

**How it works:** Spawns CLI tools (`claude`, `codex`, `gemini`, etc.) in a pseudo-terminal via `node-pty`. Streams raw terminal bytes to an `xterm.js` pane in the UI. The user sees exactly what they'd see in a terminal.

**Subscription access:** Yes — inherited from the CLI. If `claude` CLI is authenticated with Pro/Max, emdash gets it for free. Zero auth code needed.

**What you get:**
- Works with any CLI tool (21 agents supported)
- Adding a new agent = one registry entry (~1 KB of metadata: CLI name, flags, icon)
- No maintenance burden when CLIs change output format
- Subscriptions just work

**What you lose:**
- No structured data — can't parse tool calls, diffs, approvals, thinking blocks
- No mobile-friendly rendering (xterm.js on a phone is terrible)
- Can't build features on top of conversation data (forking, searching, archiving)
- Permission approvals are whatever the CLI shows in terminal
- Session management limited to what each CLI exposes (only Claude has `--session-id`)

**Architecture:** Electron app, `node-pty` → IPC → `xterm.js`. Each agent defined as flat metadata:
```typescript
{ id: 'gemini', cli: 'gemini', autoApproveFlag: '--yolo', resumeFlag: '--resume' }
```

**Verdict:** Maximum breadth, minimum depth. Works great for desktop power users who want a multi-tab terminal. Unusable for mobile supervision or any feature that requires understanding what the agent is doing.

## Approach 2: SDK Process Wrapper (Yep Anywhere)

**Project:** [Yep Anywhere](https://github.com/kzahel/yepanywhere)

**How it works:** Uses official provider SDKs to spawn and manage agent processes:
- **Claude:** `@anthropic-ai/claude-code` SDK — structured events (messages, tool calls, diffs, permission requests, thinking blocks)
- **Codex:** `@openai/codex-sdk` — structured events (messages, shell commands, file patches, sandbox modes)
- **Gemini:** `gemini -o stream-json` CLI — structured JSON stream (tool use, tool results)

Each provider's SDK/CLI handles its own authentication. Yep wraps them all with provider-specific adapters that normalize events into a unified format.

**Subscription access:** Yes — each SDK/CLI handles authentication independently (device auth, OAuth, etc.). Yep inherits whatever plan the user is authenticated with: Claude Pro/Max, ChatGPT Plus/Pro, etc.

**What you get:**
- Full structured data (messages, tool calls, diffs, permissions)
- Mobile-first UI with push notifications
- Server-owned processes (survives client disconnects)
- Fork/clone conversations, tiered inbox, context tracking
- Permission approval from your phone
- Self-hosted with E2E encrypted relay

**What you lose:**
- Coupled to each provider's SDK — Claude SDK, Codex SDK, and Gemini CLI each have different event models
- Each provider needs a custom adapter (~500+ lines) for event normalization
- SDK changes can break integration (though official SDKs provide migration paths)
- Adding new providers requires significant adapter work
- Limited to providers that ship a SDK/CLI with structured output

**Architecture:** Hono server manages SDK processes. React client connects via WebSocket. Sessions persist to JSONL files. Provider adapters normalize events into unified format.

**Key insight:** Official SDKs are the most stable way to access subscriptions programmatically. Both Anthropic and OpenAI ship SDKs (`@anthropic-ai/claude-code`, `@openai/codex-sdk`) designed for exactly this — programmatic control of their CLI agents with structured output. When SDKs change, there are documented migration paths. This is the "supported" approach for each provider.

**Verdict:** Best depth for supported providers. Adding breadth (new providers) is expensive — each needs a custom adapter. But subscription access is as stable as the official SDKs themselves.

## Approach 3: Reverse-Engineered OAuth (pi-mono)

**Project:** [pi-mono](https://github.com/badlogic/pi-mono)

**How it works:** Implements the same OAuth flows that the official CLIs use, but independently. Makes direct HTTP API calls to provider endpoints with OAuth tokens obtained from subscription authentication.

**Subscription access:** Yes — native OAuth implementation for:
- **Anthropic (Claude Pro/Max):** Opens `claude.ai/oauth/authorize` with PKCE, scopes `user:inference`
- **OpenAI (ChatGPT Plus/Pro):** OAuth callback server on localhost
- **GitHub Copilot:** Device code flow
- **Google Gemini CLI:** Cloud Code Assist OAuth

**Critical detail:** Spoofs official CLI identity:
```typescript
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
headers["user-agent"] = "claude-cli/2.1.2 (external, cli)";
headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20,...";
```

**What you get:**
- Direct API streaming (lower latency than spawning a CLI process)
- Full structured data (messages, tool calls, etc.)
- Multi-provider subscription access
- RPC mode for embedding in other apps
- Extensible provider system (`registerProvider()`)
- JSONL session persistence

**What you lose:**
- **Fragile:** Depends on undocumented OAuth endpoints and header spoofing
- No official support or migration path when things change
- TOS violation (impersonating official clients)
- Must track and match every header/beta flag change

**Real-world consequences:** This isn't theoretical risk. Google has already cracked down on OpenClaw projects that used reverse-engineered Gemini CLI OAuth tokens — users got their accounts banned. OpenCode had to disable a similar mechanism for Claude subscription tokens after TOS compliance pressure. Providers actively enforce these boundaries.

**Why providers care:** The official CLIs aren't just auth wrappers — they collect telemetry, control caching, detect credential sharing, and guard against model distillation. Bypassing the CLI to hit the API directly with spoofed credentials undermines all of these controls. Providers have strong incentives to detect and block this.

**Architecture:** TypeScript monorepo. Direct HTTP to provider APIs. OAuth tokens stored in `~/.pi/agent/auth.json` with auto-refresh and file locking. Cross-provider message transformation layer.

**Verdict:** Technically elegant for multi-provider subscription access. But the approach has already caused account bans in practice, and providers are actively tightening enforcement.

## Approach 4: API Keys Only (Vercel AI SDK)

**Project:** [Vercel AI SDK](https://github.com/vercel/ai)

**How it works:** Client-side TypeScript SDK that makes direct HTTP calls to provider APIs using API keys. 55+ provider packages implementing a unified `LanguageModelV3` interface.

**Subscription access:** No. API keys only. The optional Vercel Gateway adds routing/fallback/spend tracking but still requires per-provider API keys.

**What you get:**
- Broadest provider support (55+ providers)
- Clean provider abstraction (`generateText`, `streamText`, agent loops)
- Framework-agnostic (React, Vue, Svelte, Angular)
- Battle-tested in production at scale
- Structured output, tool calling, streaming

**What you lose:**
- No subscription-plan access at all
- No CLI integration
- No self-hosted server/gateway (library only)
- Users must have and pay for API keys
- No session persistence

**Architecture:** npm packages. Each provider is an adapter implementing `LanguageModelV3`. No server component — you import it into your app.

**Verdict:** The most mature SDK for API-key-based AI apps. Solves a different problem than subscription-plan access.

## Approach 5: Hybrid — API Keys + Legitimate OAuth (OpenCode)

**Project:** [OpenCode](https://github.com/sst/opencode)

**How it works:** Open-source agentic coding CLI that uses Vercel AI SDK adapters internally for most providers (API key based). Runs as a headless HTTP server (`opencode serve`) with OpenAPI + SSE. Additionally implements legitimate OAuth for select providers.

**Subscription access:** Partial — legitimate OAuth for two providers:
- **ChatGPT/Codex:** OAuth via `auth.openai.com` with PKCE, accesses ChatGPT Plus/Pro subscription models
- **GitHub Copilot:** Standard device code flow via GitHub's public OAuth app

OpenCode previously had a mechanism for users to obtain Claude subscription tokens through the app, but had to remove it after TOS compliance issues. For Anthropic and other providers, API keys are now required.

**What you get:**
- Strong multi-provider support via AI SDK adapters
- Codex and Copilot subscription access via official OAuth (no spoofing — honest `opencode/{version}` user-agent)
- Full HTTP server API (`/session`, `/permission`, `/event`, etc.)
- SQLite persistence with session forking/sharing
- Rich permission system
- Local model support (Ollama, LM Studio, llama.cpp)

**What you lose:**
- No Claude subscription access (API key only)
- Heavier process model (full HTTP server per session)
- OAuth scope limited to Codex and Copilot

**Verdict:** Interesting hybrid — mostly API-key-based but with legitimate subscription access for OpenAI and GitHub. Demonstrates that OAuth-based subscription access is possible without reverse-engineering, at least for providers that expose public OAuth clients.

## Summary Matrix

| Dimension | emdash | Yep Anywhere | pi-mono | Vercel AI | OpenCode |
|-----------|--------|--------------|---------|-----------|----------|
| **Subscription access** | Yes (passive) | Yes (SDK) | Yes (reverse-eng) | No | Partial (Codex, Copilot OAuth) |
| **Auth stability** | Very high | High | Low | N/A | High (legitimate OAuth) |
| **Structured output** | None | Full | Full | Full | Full |
| **Mobile viable** | No | Yes | Possible | N/A (library) | Possible |
| **Provider breadth** | 21 CLIs | 3-4 SDKs | 8+ providers | 55+ | 10+ |
| **Add new provider** | ~1 KB | ~500+ lines | ~200 lines | ~500 lines | Via AI SDK |
| **Self-hosted** | Yes | Yes | Yes | No | Yes |
| **TOS risk** | None | None | High (bans observed) | None | None (removed Claude OAuth) |
| **Maintenance surface** | Minimal (CLI flags) | SDK version upgrades | Tracking undocumented OAuth endpoints, client IDs, headers | SDK version upgrades | SDK + OAuth client changes |

## The Gap

As of this writing, no project provides a **stable, documented, multi-provider API for subscription-plan access.** The three strategies are:

1. **Spawn the CLI** (emdash, Yep) — stable but per-provider, limited to what the CLI exposes
2. **Reverse-engineer OAuth** (pi-mono) — broad but fragile and TOS-grey
3. **Legitimate OAuth where available** (OpenCode for Codex/Copilot) — stable but limited to providers that expose public OAuth clients
4. **API keys only** (Vercel AI, OpenCode for other providers) — stable but expensive

What the ecosystem arguably needs is for providers to ship an **official "subscription API"** — an endpoint where you can authenticate with your subscription credentials (OAuth) and make API calls that count against your plan limits, not a metered API key.

However, providers have reasons to resist this. The official CLIs serve as control points for telemetry collection, caching optimization, credential sharing detection, and model distillation prevention. Exposing a raw subscription API would bypass all of these controls. This tension — users wanting open access vs providers wanting to own the harness — is why the CLI/SDK wrapper approach exists and may remain the primary path.

## Open Questions

- **Will providers formalize subscription APIs?** Anthropic and OpenAI both ship SDKs that expose structured output from their CLIs, which is a step in this direction. But neither offers a documented HTTP endpoint for "make an API call against my Pro plan."
- **Can the SDK wrapper approach become a shared layer?** Rather than every project writing its own Claude SDK adapter, could there be an open-source normalization layer that multiple UIs build on top of? Yep Anywhere's provider adapters are one attempt at this — [claw-starter](https://github.com/nicedaycode/claw-starter) already builds on it.
- **Is reverse-engineered OAuth viable long-term?** Evidence says no. Google has already banned users of OpenClaw projects that reverse-engineered Gemini CLI tokens. OpenCode had to remove Claude subscription token access. Pi-mono's approach works today for some providers but the trend is toward enforcement, not tolerance.
- **Will terminal passthrough get smarter?** Projects like emdash could add lightweight output parsing (e.g., detecting ANSI escape sequences for diffs) without going full SDK integration. This middle ground is largely unexplored.

## Projects Referenced

- **emdash:** [github.com/generalaction/emdash](https://github.com/generalaction/emdash) — YC W26, desktop terminal multiplexer
- **Yep Anywhere:** [github.com/kzahel/yepanywhere](https://github.com/kzahel/yepanywhere) — mobile-first structured supervisor
- **pi-mono:** [github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono) — multi-provider coding agent with independent OAuth
- **Vercel AI SDK:** [github.com/vercel/ai](https://github.com/vercel/ai) — provider-agnostic TypeScript SDK
- **OpenCode:** [github.com/sst/opencode](https://github.com/sst/opencode) — open-source agentic coding CLI/server
