/**
 * Mock Claude provider for testing.
 *
 * Simulates Claude SDK behavior without requiring API keys or network access.
 */

import type { SDKMessage } from "../../types.js";
import type { ProviderName } from "../types.js";
import { BaseMockProvider } from "./base.js";
import type { MockProviderConfig, MockScenario } from "./types.js";

/**
 * Mock Claude provider.
 * Extends BaseMockProvider with Claude-specific defaults.
 */
export class MockClaudeProvider extends BaseMockProvider {
  readonly name: ProviderName = "claude";
  readonly displayName = "Claude";

  constructor(config: MockProviderConfig = {}) {
    super(config);
  }
}

/**
 * Mock Claude + Ollama provider.
 * Same behavior as MockClaudeProvider with different name.
 */
export class MockClaudeOllamaProvider extends BaseMockProvider {
  readonly name: ProviderName = "claude-ollama";
  readonly displayName = "Claude + Ollama";

  constructor(config: MockProviderConfig = {}) {
    super(config);
  }
}

/**
 * Create a simple Claude response scenario.
 */
export function createClaudeScenario(
  sessionId: string,
  assistantResponse: string,
  options: { delayMs?: number; includeThinking?: boolean } = {},
): MockScenario {
  const messages: SDKMessage[] = [
    {
      type: "system",
      subtype: "init",
      session_id: sessionId,
    },
  ];

  if (options.includeThinking) {
    messages.push({
      type: "assistant",
      session_id: sessionId,
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "<thinking>Let me think about this...</thinking>",
          },
        ],
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
  });

  return {
    messages,
    delayMs: options.delayMs ?? 10,
    sessionId,
  };
}

/**
 * Create a Claude tool use scenario.
 */
export function createClaudeToolScenario(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResult: string,
  finalResponse: string,
): MockScenario {
  const toolUseId = `toolu_${Date.now()}`;

  return {
    messages: [
      {
        type: "system",
        subtype: "init",
        session_id: sessionId,
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
      },
    ],
    delayMs: 10,
    sessionId,
  };
}

/**
 * Create a Claude tool approval scenario.
 */
export function createClaudeApprovalScenario(
  sessionId: string,
  toolName: string,
): MockScenario {
  return {
    messages: [
      {
        type: "system",
        subtype: "init",
        session_id: sessionId,
      },
      {
        type: "system",
        subtype: "input_request",
        session_id: sessionId,
        input_request: {
          id: `req-${Date.now()}`,
          type: "tool-approval",
          prompt: `Allow ${toolName}?`,
        },
      },
    ],
    delayMs: 10,
    sessionId,
  };
}
