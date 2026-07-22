# Multi-Provider Integration: Claude, Codex, and Gemini

## Overview

Extend Claude Anywhere to support multiple AI agent providers (Claude, OpenAI Codex, Google Gemini) through a unified abstraction layer. Users can choose which provider to use when starting a session, and sessions display which provider is running them.

## Research Findings

### Provider Comparison

| Aspect | Claude | Codex | Gemini |
|--------|--------|-------|--------|
| Language | TypeScript SDK | Rust CLI + TS SDK | Node.js CLI |
| Non-interactive | SDK `query()` | `codex exec --json` | `gemini -o stream-json` |
| Session format | JSONL | JSONL (nearly identical) | JSON |
| Auth storage | N/A (API key) | `~/.codex/auth.json` | `~/.gemini/oauth_creds.json` |
| Sessions path | `~/.claude/projects/` | `~/.codex/sessions/` | `~/.gemini/tmp/<hash>/chats/` |

### Existing Architecture (Already Extensible)

The current architecture is well-positioned for multi-provider:

- `RealClaudeSDKInterface` returns `{ iterator, queue, abort }` - any provider can implement this
- `Process` only consumes async iterator - provider-agnostic
- `SDKMessage` is loosely typed - new providers won't break it
- `Supervisor` doesn't know SDK details

## Phase 1: Provider Abstraction Layer

### Goal
Refactor existing Claude SDK integration into a provider pattern without changing behavior.

### Files to Create

#### `packages/server/src/sdk/providers/types.ts`
Common provider interface:

```typescript
export interface AgentProvider {
  name: 'claude' | 'codex' | 'gemini';
  displayName: string;

  // Check if this provider is available
  isInstalled(): Promise<boolean>;
  isAuthenticated(): Promise<boolean>;
  getAuthStatus(): Promise<AuthStatus>;

  // Start a session
  startSession(options: StartSessionOptions): Promise<AgentSession>;
}

export interface AgentSession {
  iterator: AsyncIterableIterator<SDKMessage>;
  queue: MessageQueue;
  abort: () => void;
  sessionId?: string;
}

export interface AuthStatus {
  installed: boolean;
  authenticated: boolean;
  expiresAt?: Date;
  user?: { email?: string; name?: string };
}

export interface StartSessionOptions {
  cwd: string;
  resume?: string;
  model?: string;
  permissionMode: PermissionMode;
  canUseTool: ToolApprovalCallback;
}
```

#### `packages/server/src/sdk/providers/claude.ts`
Refactor current `real.ts` to implement `AgentProvider`:

```typescript
export class ClaudeProvider implements AgentProvider {
  name = 'claude' as const;
  displayName = 'Claude';

  async isInstalled(): Promise<boolean> {
    // Claude SDK is bundled, always available
    return true;
  }

  async isAuthenticated(): Promise<boolean> {
    // Check ANTHROPIC_API_KEY env var
    return !!process.env.ANTHROPIC_API_KEY;
  }

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    // Current real.ts implementation
  }
}
```

### Files to Modify

#### `packages/server/src/sdk/real.ts`
- Extract core logic to `providers/claude.ts`
- Keep as thin re-export for backward compatibility

#### `packages/server/src/app.ts`
- Create provider registry
- Pass available providers to Supervisor

### Verification

```bash
pnpm typecheck
pnpm test
pnpm test:e2e
```

All existing tests should pass - this is a refactor, not a behavior change.

---

## Phase 2: Provider Detection

### Goal
Detect which CLIs are installed and authenticated.

### Files to Create

#### `packages/server/src/sdk/detection.ts`

```typescript
export interface ProviderStatus {
  name: string;
  displayName: string;
  installed: boolean;
  authenticated: boolean;
  authExpiry?: Date;
  user?: { email?: string };
}

export async function detectProviders(): Promise<ProviderStatus[]> {
  // Check each provider
}

export async function checkCodexAuth(): Promise<AuthStatus> {
  // Read ~/.codex/auth.json
  // Check token expiry
}

export async function checkGeminiAuth(): Promise<AuthStatus> {
  // Read ~/.gemini/oauth_creds.json
  // Check expiry_date field
}
```

#### `packages/server/src/routes/providers.ts`
New API endpoint:

```typescript
// GET /api/providers
// Returns list of available providers with auth status

// GET /api/providers/:name/status
// Returns detailed status for specific provider
```

### Files to Modify

#### `packages/server/src/app.ts`
- Mount `/api/providers` routes

#### `packages/shared/src/api-types.ts`
- Add provider status types

---

## Phase 3: Codex Provider

### Goal
Implement Codex provider using `codex exec --json`.

### Files to Create

#### `packages/server/src/sdk/providers/codex.ts`

```typescript
export class CodexProvider implements AgentProvider {
  name = 'codex' as const;
  displayName = 'Codex';

  async isInstalled(): Promise<boolean> {
    // Check if `codex` binary exists
    return which('codex') !== null;
  }

  async isAuthenticated(): Promise<boolean> {
    // Read ~/.codex/auth.json
  }

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    // Spawn: codex exec "prompt" --json -C <cwd>
    // Parse JSONL stream from stdout
    // Yield normalized SDKMessage objects
  }
}
```

#### `packages/shared/src/codex-schema/`
Zod schemas for Codex event types:

```typescript
// Based on session file analysis:
// - session_meta
// - response_item (message, reasoning, ghost_snapshot)
// - event_msg (user_message, agent_message, token_count, agent_reasoning)
// - turn_context
```

#### `packages/server/src/sdk/providers/codex.test.ts`
Unit tests with mock CLI output.

### Event Normalization

Map Codex events to our internal format:

| Codex Event | Our Event |
|-------------|-----------|
| `event_msg.agent_message` | assistant message |
| `event_msg.user_message` | user message |
| `response_item.reasoning` | thinking block |
| `event_msg.token_count` | usage stats |

---

## Phase 4: Gemini Provider

### Goal
Implement Gemini provider using `gemini -o stream-json`.

### Files to Create

#### `packages/server/src/sdk/providers/gemini.ts`

```typescript
export class GeminiProvider implements AgentProvider {
  name = 'gemini' as const;
  displayName = 'Gemini';

  async isInstalled(): Promise<boolean> {
    return which('gemini') !== null;
  }

  async isAuthenticated(): Promise<boolean> {
    // Read ~/.gemini/oauth_creds.json
    // Check expiry_date
  }

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    // Spawn: gemini "prompt" -o stream-json
    // Parse JSON stream from stdout
    // Yield normalized SDKMessage objects
  }
}
```

#### `packages/shared/src/gemini-schema/`
Zod schemas for Gemini event types:

```typescript
// Based on session file analysis:
// - type: 'user' | 'gemini' | 'info'
// - thoughts array with subject/description
// - tokens breakdown
```

---

## Phase 5: UI - Provider Selection

### Goal
Add provider selection when starting a new session.

### Files to Modify

#### `packages/client/src/components/NewSessionModal.tsx` (or similar)
- Show provider dropdown/selector
- Show auth status for each provider
- Disable unavailable providers
- Default to last-used or Claude

#### `packages/client/src/hooks/useProviders.ts`
Hook to fetch and cache provider status:

```typescript
export function useProviders() {
  // GET /api/providers
  // Return { providers, isLoading, refetch }
}
```

#### `packages/client/src/components/SessionCard.tsx`
- Show provider badge/icon on session list

#### `packages/client/src/pages/SessionPage.tsx`
- Show provider indicator in header

### API Changes

#### `POST /api/sessions`
Add `provider` field:

```typescript
{
  projectId: string;
  message: string;
  provider?: 'claude' | 'codex' | 'gemini';  // default: 'claude'
}
```

---

## Phase 6: Mock Providers & Testing Infrastructure

### Goal
Extend existing mock infrastructure to support multiple providers.

### Research Findings

**Neither Codex nor Gemini provide public mock SDKs.** Both have internal testing infrastructure:
- Codex: Internal Rust SSE mocking (`mount_sse*` helpers), `CODEX_RS_SSE_FIXTURE` env var
- Gemini: Internal "golden file" system, `REGENERATE_MODEL_GOLDENS=true` flag

**We must build our own mock providers.**

### Existing Infrastructure to Extend

Current mock system in `packages/server/src/sdk/mock.ts`:

```typescript
// Already have this pattern
export class MockClaudeSDK implements ClaudeSDK {
  private scenarios: MockScenario[] = [];

  async *startSession(options): AsyncIterableIterator<SDKMessage> {
    // Yields messages from scenarios with optional delays
  }
}

interface MockScenario {
  messages: SDKMessage[];
  delayMs?: number;
}
```

**Existing helpers:**
- `createMockScenario()` - Creates init → assistant → result flow
- `createToolApprovalScenario()` - Creates scenarios with tool approval
- `dev-mock.ts` - Runs full app with mock SDK

**Existing fixtures:** `packages/server/test/fixtures/agents/*.jsonl`

### Files to Create

#### `packages/server/src/sdk/providers/__mocks__/codex.ts`

```typescript
export class MockCodexProvider implements AgentProvider {
  name = 'codex' as const;
  private scenarios: MockScenario[] = [];

  async isInstalled() { return true; }
  async isAuthenticated() { return true; }

  async startSession(options): Promise<AgentSession> {
    const scenario = this.scenarios[this.scenarioIndex++ % this.scenarios.length];
    return {
      iterator: this.createIterator(scenario),
      queue: new MockMessageQueue(),
      abort: () => {},
    };
  }

  private async *createIterator(scenario: MockScenario) {
    for (const msg of scenario.messages) {
      if (scenario.delayMs) await sleep(scenario.delayMs);
      yield normalizeCodexMessage(msg);  // Convert to SDKMessage
    }
  }
}
```

#### `packages/server/src/sdk/providers/__mocks__/gemini.ts`

```typescript
export class MockGeminiProvider implements AgentProvider {
  name = 'gemini' as const;
  // Same pattern as MockCodexProvider
  // Uses normalizeGeminiMessage() for format conversion
}
```

#### `packages/server/src/sdk/providers/__mocks__/factory.ts`

```typescript
export function createMockProvider(
  type: 'claude' | 'codex' | 'gemini',
  scenarios: MockScenario[] = []
): AgentProvider {
  switch (type) {
    case 'claude': return new MockClaudeProvider(scenarios);
    case 'codex': return new MockCodexProvider(scenarios);
    case 'gemini': return new MockGeminiProvider(scenarios);
  }
}
```

#### Fixture Files

```
packages/server/test/fixtures/
├── claude/
│   ├── simple-response.jsonl
│   ├── tool-use.jsonl
│   └── multi-turn.jsonl
├── codex/
│   ├── simple-response.jsonl      # Codex JSONL format
│   ├── tool-use.jsonl
│   └── reasoning.jsonl            # With encrypted reasoning
└── gemini/
    ├── simple-response.json       # Gemini JSON format
    ├── tool-use.json
    └── thoughts.json              # With thoughts array
```

### Test Patterns

#### Unit Tests with Mock Providers

```typescript
// packages/server/test/providers/codex.test.ts
describe("CodexProvider", () => {
  let provider: MockCodexProvider;

  beforeEach(() => {
    provider = new MockCodexProvider([
      loadFixture('codex/simple-response.jsonl')
    ]);
  });

  it("normalizes messages to SDKMessage format", async () => {
    const { iterator } = await provider.startSession({ cwd: '/test' });
    const messages = await collect(iterator);

    // All providers should output consistent SDKMessage format
    expect(messages[0]).toMatchObject({
      type: 'system',
      subtype: 'init',
    });
  });
});
```

#### Parameterized Tests Across Providers

```typescript
describe.each(['claude', 'codex', 'gemini'] as const)(
  '%s provider',
  (providerType) => {
    let provider: AgentProvider;

    beforeEach(() => {
      provider = createMockProvider(providerType, [
        loadFixture(`${providerType}/simple-response`)
      ]);
    });

    it("streams messages", async () => {
      const { iterator } = await provider.startSession({ cwd: '/test' });
      const messages = await collect(iterator);
      expect(messages.length).toBeGreaterThan(0);
    });

    it("supports abort", async () => {
      const { iterator, abort } = await provider.startSession({ cwd: '/test' });
      abort();
      // Should terminate cleanly
    });
  }
);
```

#### Dev Mock Server

Update `dev-mock.ts` to support provider selection:

```typescript
const mockProviders = {
  claude: new MockClaudeProvider([...]),
  codex: new MockCodexProvider([...]),
  gemini: new MockGeminiProvider([...]),
};

const app = createApp({
  providers: mockProviders,
  defaultProvider: 'claude',
});
```

### Environment Variables

```bash
# Unit tests - always use mocks
pnpm test

# E2E with specific real provider
PROVIDER_TESTS=claude pnpm test:e2e
PROVIDER_TESTS=codex pnpm test:e2e
PROVIDER_TESTS=gemini pnpm test:e2e
PROVIDER_TESTS=all pnpm test:e2e

# Dev server with mocks
pnpm dev-mock
```

---

## Phase 7: Local Model E2E Testing Infrastructure (HIGH PRIORITY)

### Goal
Establish robust E2E testing using local models (Ollama + Qwen). This enables free, fast, real LLM testing without API costs.

### Why High Priority

- **Free**: No API costs, run tests as often as needed
- **Fast**: Sub-second local inference vs 2-5s cloud latency
- **Real behavior**: Actual LLM tool calling, not scripted mocks
- **Reproducible**: Pin model version for consistent results
- **Dev-friendly**: Iterate quickly during development

### Testing Pyramid

```
                    ┌─────────────────┐
                    │  Cloud E2E      │  Expensive, gated, release only
                    │  (Claude/Codex) │  PROVIDER_TESTS=cloud
                    └────────┬────────┘
               ┌─────────────▼─────────────┐
               │    Local Model E2E        │  FREE, real LLM behavior
               │  (Ollama + Qwen 2.5)      │  pnpm test:e2e:local
               └─────────────┬─────────────┘
         ┌───────────────────▼───────────────────┐
         │         Integration Tests              │  Mock LLM, real file ops
         │    (Mock provider + real filesystem)   │  pnpm test:integration
         └───────────────────┬───────────────────┘
    ┌────────────────────────▼────────────────────────┐
    │                  Unit Tests                      │  Fast, deterministic
    │         (Mock everything, fixtures)              │  pnpm test
    └──────────────────────────────────────────────────┘
```

### Hardware Requirements

RTX 4090 (24GB VRAM) can run:

| Model | VRAM | Speed | Quality | Use Case |
|-------|------|-------|---------|----------|
| Qwen 2.5 Coder 7B | ~6GB | Very fast | Good | CI, quick iteration |
| Qwen 2.5 Coder 14B | ~10GB | Fast | Better | Regular dev testing |
| Qwen 2.5 Coder 32B Q5 | ~20GB | Medium | Best | Full E2E validation |

### Setup

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull models (do once)
ollama pull qwen2.5-coder:7b      # Fast, for CI
ollama pull qwen2.5-coder:32b     # Quality, for dev

# Start Ollama server
ollama serve

# Optional: LiteLLM proxy for Anthropic API compatibility
pip install litellm
litellm --model ollama/qwen2.5-coder:32b --port 4000
```

### Files to Create

#### `packages/server/src/sdk/providers/local-model.ts`

```typescript
export class LocalModelProvider implements AgentProvider {
  name = 'local' as const;
  displayName = 'Local Model';

  constructor(private config: {
    model?: string;  // default: qwen2.5-coder:7b
    baseUrl?: string;  // default: http://localhost:11434/v1
  } = {}) {}

  async isInstalled(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async isAuthenticated(): Promise<boolean> {
    return true;  // No auth needed for local
  }

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    // Use OpenAI-compatible endpoint directly
    // OR proxy through LiteLLM for Anthropic compatibility
  }
}
```

#### `packages/server/test/e2e/local-model.e2e.test.ts`

```typescript
import { LocalModelProvider } from '../../src/sdk/providers/local-model';

describe("Local Model E2E", () => {
  let provider: LocalModelProvider;
  let testDir: string;

  beforeAll(async () => {
    provider = new LocalModelProvider({ model: 'qwen2.5-coder:7b' });

    if (!(await provider.isInstalled())) {
      console.log("Skipping local E2E tests - Ollama not running");
      return;
    }

    testDir = await createTempTestDir();
  });

  afterAll(async () => {
    await cleanupTempTestDir(testDir);
  });

  it("creates a file when asked", async () => {
    const { iterator } = await provider.startSession({
      cwd: testDir,
      initialMessage: {
        text: "Create a file called hello.txt containing 'Hello World'"
      }
    });

    await collectUntilComplete(iterator);

    // Verify actual file was created
    const content = fs.readFileSync(path.join(testDir, "hello.txt"), "utf8");
    expect(content).toContain("Hello");
  });

  it("reads and modifies files", async () => {
    // Create initial file
    fs.writeFileSync(path.join(testDir, "counter.txt"), "0");

    const { iterator } = await provider.startSession({
      cwd: testDir,
      initialMessage: {
        text: "Read counter.txt, increment the number, write it back"
      }
    });

    await collectUntilComplete(iterator);

    const content = fs.readFileSync(path.join(testDir, "counter.txt"), "utf8");
    expect(content.trim()).toBe("1");
  });

  it("executes shell commands", async () => {
    const { iterator } = await provider.startSession({
      cwd: testDir,
      initialMessage: { text: "Run 'echo hello' and tell me the output" }
    });

    const messages = await collectUntilComplete(iterator);
    const assistantMessages = messages.filter(m => m.type === 'assistant');

    expect(assistantMessages.some(m =>
      JSON.stringify(m).includes('hello')
    )).toBe(true);
  });

  it("handles errors gracefully", async () => {
    const { iterator } = await provider.startSession({
      cwd: testDir,
      initialMessage: {
        text: "Try to read /nonexistent/file.txt and explain what happened"
      }
    });

    const messages = await collectUntilComplete(iterator);

    // Should complete without throwing
    expect(messages.some(m => m.type === 'result')).toBe(true);
  });
});
```

### Test Commands

```bash
# Unit tests - mocks only, fast (CI default)
pnpm test

# Integration - mock LLM, real filesystem
pnpm test:integration

# Local E2E - requires Ollama running
pnpm test:e2e:local              # Uses 7B model (fast)
pnpm test:e2e:local:quality      # Uses 32B model (thorough)

# Cloud E2E - requires API keys, expensive
PROVIDER_TESTS=claude pnpm test:e2e:cloud
PROVIDER_TESTS=codex pnpm test:e2e:cloud
PROVIDER_TESTS=all pnpm test:e2e:cloud
```

### CI Configuration

```yaml
# .github/workflows/test.yml
jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test

  local-e2e:
    runs-on: [self-hosted, gpu]  # GPU runner
    steps:
      - name: Start Ollama
        run: |
          ollama serve &
          sleep 5
          ollama pull qwen2.5-coder:7b
      - run: pnpm test:e2e:local
```

### Comparison: Mock vs Local vs Cloud

| Aspect | Mock | Local Model | Cloud API |
|--------|------|-------------|-----------|
| Speed | <1ms | 100ms-2s | 2-5s |
| Cost | Free | Free | $5-10/M tokens |
| Deterministic | 100% | ~95% | ~90% |
| Real tool calls | No | Yes | Yes |
| Edge case discovery | No | Yes | Yes |
| CI friendly | Yes | Needs GPU | Rate limited |
| Offline | Yes | Yes | No |

---

## Phase 8: Cloud E2E Tests

### Goal
Full integration tests against real cloud providers (Claude, Codex, Gemini).

### Test Cases

1. **Provider detection**
   - Detect installed providers
   - Show correct auth status

2. **Session creation**
   - Create session with each provider
   - Verify events stream correctly

3. **Provider switching**
   - Start session with Codex
   - Start another with Gemini
   - Verify both work independently

4. **Auth expiry handling**
   - Expired tokens show correct status
   - Graceful error on auth failure

### When to Run

- **Not in CI** (expensive, rate limited)
- **Pre-release validation**
- **Manual testing during development**

---

## Implementation Order (Updated)

1. **Phase 1: Provider Abstraction** - Refactor only, no new features
2. **Phase 7: Local Model E2E** - HIGH PRIORITY: Establish test infrastructure early
3. **Phase 2: Provider Detection** - API for provider status
4. **Phase 3: Codex Provider** - First new provider (test with local E2E)
5. **Phase 6: Mock Providers** - Fixture-based mocks for unit tests
6. **Phase 5: UI** - Enable selection (test with local + mocks)
7. **Phase 4: Gemini Provider** - Second new provider
8. **Phase 8: Cloud E2E** - Final validation against real APIs

**Key insight**: Local model E2E moved to #2. This gives us real LLM testing infrastructure before adding new providers, so we can validate each provider against real behavior as we build.

---

## Future Considerations (Out of Scope)

### Cross-provider subagents
Allow one provider to spawn subagents using another provider. Requires:
- Custom tool definitions per provider
- Subagent orchestration layer
- Context passing between providers

### Session format unification
Currently we'd store sessions in each provider's native format. Could unify:
- Convert all to our own JSONL format
- Enable cross-provider session viewing
- Migration path for existing sessions

---

## Open Questions

1. **Resume behavior**: Each CLI has its own resume. Do we use theirs or implement our own?
2. **Session storage**: Use their session paths or create our own unified path?
3. **Tool approval**: Map our permission modes to each CLI's approval flags?
4. **Model selection**: Expose model picker per provider? (o3 for Codex, gemini-2.5-flash for Gemini)
