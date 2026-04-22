# Multi-Provider Integration: Executive Summary

## Product Vision

**Goal:** Transform Claude Anywhere from a Claude-specific supervisor into a universal AI agent supervisor supporting multiple providers (Claude, OpenAI Codex, Google Gemini).

**User Value:**
- **Choice**: Use the best model for each task (Claude for analysis, Codex for code, Gemini for exploration)
- **Unified Interface**: One dashboard for all AI agents, regardless of provider
- **Seamless Switching**: Start with Claude, spawn Codex subagent, all in one session
- **Future-Proof**: Add new providers as they emerge

**Key Insight:** All three providers now have similar capabilities (agentic coding, tool use, file editing) but different strengths. Users shouldn't have to choose one ecosystem.

---

## Technical Vision

**Architecture Principle:** Provider-agnostic core with pluggable provider adapters.

```
┌─────────────────────────────────────────────────┐
│                   UI Layer                       │
│         (Provider selector, session view)        │
└─────────────────────┬───────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────┐
│                 Supervisor                       │
│    (Process management, event streaming)         │
└─────────────────────┬───────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────┐
│            AgentProvider Interface               │
│   { startSession, isInstalled, isAuthenticated } │
└───────┬─────────────┼─────────────┬─────────────┘
        │             │             │
   ┌────▼────┐  ┌─────▼─────┐  ┌────▼────┐
   │ Claude  │  │   Codex   │  │  Gemini │
   │Provider │  │  Provider │  │ Provider│
   └─────────┘  └───────────┘  └─────────┘
```

**Key Technical Decisions:**
1. **Unified `AgentProvider` interface** - All providers implement same contract
2. **Event normalization** - Provider-specific events → common `SDKMessage` format
3. **CLI-based integration** - Spawn `codex exec --json` and `gemini -o stream-json`
4. **Auth detection** - Read provider auth files to check availability
5. **Mock infrastructure** - Scenario-based mocks for all providers

---

## Phase Overview

### Phase 1: Provider Abstraction *(Foundation)*
Refactor existing Claude SDK into `AgentProvider` pattern. No new features, just clean abstraction.

### Phase 2: Local Model E2E Testing *(HIGH PRIORITY)*
Establish robust testing infrastructure using Ollama + Qwen. Free, fast, real LLM behavior.

### Phase 3: Provider Detection *(Discovery)*
API to detect installed CLIs and auth status. Users see which providers are available.

### Phase 4: Codex Provider *(First Integration)*
Implement Codex adapter. Spawn CLI, parse JSONL stream, normalize events.

### Phase 5: Mock Providers *(Unit Testing)*
Fixture-based mocks for all providers. Fast, deterministic unit tests.

### Phase 6: UI Updates *(User-Facing)*
Provider selector at session start. Provider badges on session list. Auth status indicators.

### Phase 7: Gemini Provider *(Second Integration)*
Implement Gemini adapter. Same pattern, different format (JSON vs JSONL).

### Phase 8: Cloud E2E Tests *(Final Validation)*
Full integration tests with real cloud APIs (gated, expensive, pre-release only).

---

## Implementation Strategy

**Start with what works:** Claude is already working. Use it as the reference implementation.

**Test infrastructure early:** Local model E2E testing (Phase 2) before adding new providers. This gives us real LLM behavior testing for free.

**Codex first:** JSONL format nearly identical to Claude. Lowest integration risk.

**Gemini second:** JSON format is different but simple. More normalization work.

**Test as we go:** Each phase includes its own verification. No big-bang integration.

### Testing Pyramid

```
                    ┌─────────────────┐
                    │  Cloud E2E      │  Expensive, pre-release only
                    └────────┬────────┘
               ┌─────────────▼─────────────┐
               │    Local Model E2E        │  FREE, real LLM behavior
               │  (Ollama + Qwen on 4090)  │  Run frequently during dev
               └─────────────┬─────────────┘
         ┌───────────────────▼───────────────────┐
         │         Integration Tests              │  Mock LLM, real file ops
         └───────────────────┬───────────────────┘
    ┌────────────────────────▼────────────────────────┐
    │                  Unit Tests                      │  Fast, deterministic
    └──────────────────────────────────────────────────┘
```

---

## Success Criteria

1. **Functional:** Can start sessions with any installed provider
2. **Observable:** UI shows which provider is running each session
3. **Testable:** Mock providers enable full test coverage without API calls
4. **Extensible:** Adding a new provider is ~1 new file + fixtures

---

## Future Roadmap (Post-MVP)

1. **Local/OSS Models:** Self-hosted models via Ollama + LiteLLM proxy (see [research doc](../research/local-oss-models.md))
   - Zero-code path: LiteLLM translates OpenAI→Anthropic, existing Claude SDK works
   - Best models: Qwen 2.5 Coder 32B, Devstral Small 2
2. **Cross-Provider Subagents:** Claude spawns Codex as subagent (see [research doc](../research/cross-provider-subagents.md))
3. **Model Selection:** Pick specific models per provider (o3, gemini-2.5-flash, etc.)
4. **Unified Session Format:** Optional conversion to common storage format

---

## Related Documents

| Document | Purpose |
|----------|---------|
| [Multi-Provider Integration Plan](./multi-provider-integration.md) | Detailed implementation plan with code examples |
| [Cross-Provider Subagents](../research/cross-provider-subagents.md) | Future: agents spawning other agents |
| [Golden Conversation Generation](../research/golden-conversation-generation.md) | Test fixture generation guide |
| [Local/OSS Models](../research/local-oss-models.md) | Self-hosted model integration (Ollama, LiteLLM) |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| CLI APIs change | Pin CLI versions, abstract behind provider interface |
| Auth token expiry | Detect expiry, show clear error, guide user to re-auth |
| Format differences | Normalize early, test extensively with fixtures |
| Performance overhead | CLI spawn is one-time cost; streaming is efficient |

---

## Getting Started

1. **Install CLIs:**
   ```bash
   npm install -g @openai/codex @google/gemini-cli
   ```

2. **Authenticate:**
   ```bash
   codex login    # Opens browser for OAuth
   gemini         # Prompts for auth on first run
   ```

3. **Verify:**
   ```bash
   ls ~/.codex/auth.json      # Should exist
   ls ~/.gemini/oauth_creds.json  # Should exist
   ```

4. **Start development:** Begin with Phase 1 (provider abstraction refactor)
