/**
 * Provider exports.
 *
 * Re-exports all provider implementations and types.
 */

// Types
import type { AgentProvider, ProviderName } from "./types.js";
export type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  ProviderName,
  StartSessionOptions,
} from "./types.js";

// Claude provider (uses @anthropic-ai/claude-agent-sdk)
import { claudeProvider } from "./claude.js";
export { ClaudeProvider, claudeProvider } from "./claude.js";

// Codex provider (uses codex CLI)
import { codexProvider } from "./codex.js";
export {
  CodexProvider,
  codexProvider,
  type CodexProviderConfig,
} from "./codex.js";

// Gemini provider (uses gemini CLI)
import { geminiProvider } from "./gemini.js";
export {
  GeminiProvider,
  geminiProvider,
  type GeminiProviderConfig,
} from "./gemini.js";

// Gemini ACP provider (uses gemini CLI with --experimental-acp)
import { geminiACPProvider } from "./gemini-acp.js";
export {
  GeminiACPProvider,
  geminiACPProvider,
  type GeminiACPProviderConfig,
} from "./gemini-acp.js";

// CodexOSS provider (uses codex CLI with --oss for local models)
import { codexOSSProvider } from "./codex-oss.js";
export {
  CodexOSSProvider,
  codexOSSProvider,
  type CodexOSSProviderConfig,
} from "./codex-oss.js";

// Claude + Ollama provider (uses Claude SDK with Ollama backend)
import { claudeOllamaProvider } from "./claude-ollama.js";
export {
  ClaudeOllamaProvider,
  claudeOllamaProvider,
} from "./claude-ollama.js";

// OpenCode provider (uses opencode serve for multi-provider agent)
import { opencodeProvider } from "./opencode.js";
export {
  OpenCodeProvider,
  opencodeProvider,
  type OpenCodeProviderConfig,
} from "./opencode.js";

import type { IProviderAdapter } from "../../providers/adapter.js";
import { providerRegistry } from "../../providers/registry.js";

/**
 * Get all available provider instances.
 * Useful for provider detection UI.
 */
export function getAllProviders(): AgentProvider[] {
  return providerRegistry
    .list()
    .map((d) =>
      "getAgentProvider" in d
        ? (d as IProviderAdapter).getAgentProvider()
        : null,
    )
    .filter((p): p is AgentProvider => p !== null);
}

/**
 * Get a provider by name.
 *
 * Note: "gemini" maps to geminiACPProvider (ACP mode) since it's the better
 * implementation with proper permission handling. The non-ACP stream-json
 * provider is deprecated and will be removed.
 */
export function getProvider(name: ProviderName): AgentProvider | null {
  const descriptor = providerRegistry.getOrNull(name);
  if (descriptor && "getAgentProvider" in descriptor) {
    return (descriptor as IProviderAdapter).getAgentProvider();
  }
  return null;
}
