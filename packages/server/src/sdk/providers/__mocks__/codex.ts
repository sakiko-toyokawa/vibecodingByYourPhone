/**
 * Mock Codex provider for testing.
 *
 * Simulates Codex CLI behavior without requiring the CLI or API keys.
 * Normalizes Codex-specific message formats to SDKMessage format.
 */

import type { SDKMessage } from "../../types.js";
import type { ProviderName } from "../types.js";
import { BaseMockProvider } from "./base.js";
import type { MockProviderConfig, MockScenario } from "./types.js";

/**
 * Mock Codex provider.
 * Extends BaseMockProvider with Codex-specific defaults.
 */
export class MockCodexProvider extends BaseMockProvider {
  readonly name: ProviderName = "codex";
  readonly displayName = "Codex";

  constructor(config: MockProviderConfig = {}) {
    super(config);
  }
}

/**
 * Mock Codex OSS provider.
 * Same as MockCodexProvider but with codex-oss name.
 */
export class MockCodexOSSProvider extends BaseMockProvider {
  readonly name: ProviderName = "codex-oss";
  readonly displayName = "CodexOSS";

  constructor(config: MockProviderConfig = {}) {
    super(config);
  }
}

/**
 * Create a simple Codex response scenario.
 * Messages are already normalized to SDKMessage format.
 */
export function createCodexScenario(
  sessionId: string,
  assistantResponse: string,
  options: { delayMs?: number; includeReasoning?: boolean } = {},
): MockScenario {
  const messages: SDKMessage[] = [
    {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: "gpt-4",
    },
  ];

  if (options.includeReasoning) {
    messages.push({
      type: "assistant",
      session_id: sessionId,
      message: {
        role: "assistant",
        content: "<thinking>\nLet me analyze this step by step...\n</thinking>",
      },
    });
  }

  messages.push({
    type: "assistant",
    session_id: sessionId,
    message: {
      role: "assistant",
      content: assistantResponse,
    },
  });

  messages.push({
    type: "result",
    session_id: sessionId,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
    },
  });

  return {
    messages,
    delayMs: options.delayMs ?? 10,
    sessionId,
  };
}

/**
 * Create a Codex tool use scenario.
 * Uses function_call format normalized to tool_use.
 */
export function createCodexToolScenario(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResult: string,
  finalResponse: string,
): MockScenario {
  const toolUseId = `call_${Date.now()}`;

  return {
    messages: [
      {
        type: "system",
        subtype: "init",
        session_id: sessionId,
        model: "gpt-4",
      },
      {
        type: "assistant",
        session_id: sessionId,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: toolUseId,
              name: toolName,
              input: toolInput,
            },
          ],
        },
      },
      {
        type: "user",
        session_id: sessionId,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: toolResult,
            },
          ],
        },
      },
      {
        type: "assistant",
        session_id: sessionId,
        message: {
          role: "assistant",
          content: finalResponse,
        },
      },
      {
        type: "result",
        session_id: sessionId,
        usage: {
          input_tokens: 200,
          output_tokens: 100,
        },
      },
    ],
    delayMs: 10,
    sessionId,
  };
}

/**
 * Create a Codex error scenario.
 */
export function createCodexErrorScenario(
  sessionId: string,
  errorMessage: string,
): MockScenario {
  return {
    messages: [
      {
        type: "system",
        subtype: "init",
        session_id: sessionId,
      },
      {
        type: "error",
        session_id: sessionId,
        error: errorMessage,
      },
    ],
    delayMs: 10,
    sessionId,
  };
}
