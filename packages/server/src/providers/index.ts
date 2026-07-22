import type { ModelInfoService } from "../services/ModelInfoService.js";
import { ClaudeOllamaProviderDescriptor } from "./claude-ollama.js";
import { ClaudeProviderDescriptor } from "./claude.js";
import { CodexProviderDescriptor } from "./codex.js";
import { GeminiProviderDescriptor } from "./gemini.js";
import { OpenCodeProviderDescriptor } from "./opencode.js";
import { providerRegistry } from "./registry.js";

export { providerRegistry } from "./registry.js";
export type { ProviderDescriptor, ProviderScanner } from "./descriptor.js";
export type { IProviderAdapter } from "./adapter.js";
export { ProviderRegistry } from "./registry.js";
export { ClaudeOllamaProviderDescriptor } from "./claude-ollama.js";
export { ClaudeProviderDescriptor } from "./claude.js";
export { CodexProviderDescriptor } from "./codex.js";
export { GeminiProviderDescriptor } from "./gemini.js";
export { OpenCodeProviderDescriptor } from "./opencode.js";

export function registerAllProviders(
  modelInfoService?: ModelInfoService,
): void {
  if (providerRegistry.list().length > 0) {
    return;
  }
  providerRegistry.register(new ClaudeProviderDescriptor(modelInfoService));
  providerRegistry.register(
    new ClaudeOllamaProviderDescriptor(modelInfoService),
  );
  providerRegistry.register(new CodexProviderDescriptor());
  providerRegistry.register(new GeminiProviderDescriptor());
  providerRegistry.register(new OpenCodeProviderDescriptor());
}
