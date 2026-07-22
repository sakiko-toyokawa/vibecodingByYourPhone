import {
  MockClaudeOllamaProvider,
  MockClaudeProvider,
} from "../sdk/providers/__mocks__/claude.js";
import {
  MockCodexOSSProvider,
  MockCodexProvider,
} from "../sdk/providers/__mocks__/codex.js";
import { MockGeminiProvider } from "../sdk/providers/__mocks__/gemini.js";
import { MockOpenCodeProvider } from "../sdk/providers/__mocks__/opencode.js";
import type {
  MockAgentProvider,
  MockProviderConfig,
} from "../sdk/providers/__mocks__/types.js";
import type { ProviderName } from "../sdk/providers/types.js";

const mockFactories: Record<
  ProviderName,
  (config: MockProviderConfig) => MockAgentProvider
> = {
  claude: (c) => new MockClaudeProvider(c),
  "claude-ollama": (c) => new MockClaudeOllamaProvider(c),
  codex: (c) => new MockCodexProvider(c),
  "codex-oss": (c) => new MockCodexOSSProvider(c),
  gemini: (c) => new MockGeminiProvider(c),
  "gemini-acp": (c) => new MockGeminiProvider(c),
  opencode: (c) => new MockOpenCodeProvider(c),
};

export function createMockProvider(
  type: ProviderName,
  config: MockProviderConfig = {},
): MockAgentProvider {
  const factory = mockFactories[type];
  if (!factory) {
    throw new Error(`Unknown provider type: ${type}`);
  }
  return factory(config);
}

export function createAllMockProviders(
  config: MockProviderConfig = {},
): Map<ProviderName, MockAgentProvider> {
  const providers = new Map<ProviderName, MockAgentProvider>();
  for (const [name, factory] of Object.entries(mockFactories)) {
    providers.set(name as ProviderName, factory(config));
  }
  return providers;
}

export const MOCK_PROVIDER_TYPES: ProviderName[] = Object.keys(
  mockFactories,
) as ProviderName[];
