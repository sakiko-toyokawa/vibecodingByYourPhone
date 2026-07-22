/**
 * Factory functions for creating mock providers.
 *
 * Provides a unified way to create mock providers for testing.
 */

import type { SDKMessage } from "../../types.js";
import type { ProviderName } from "../types.js";
import type {
  MockAgentProvider,
  MockProviderConfig,
  MockScenario,
} from "./types.js";

// Re-export core factory functions from mock-registry (switch/case-free)
export {
  createMockProvider,
  createAllMockProviders,
  MOCK_PROVIDER_TYPES,
} from "../../../providers/mock-registry.js";

/**
 * Create a mock provider with pre-configured scenarios.
 */
export function createMockProviderWithScenarios(
  type: ProviderName,
  scenarios: MockScenario[],
): MockAgentProvider {
  // Use dynamic import to avoid circular dependency at top level
  const { createMockProvider } = require("../../../providers/mock-registry.js");
  return createMockProvider(type, { scenarios });
}

/**
 * Create a standard test scenario that works with any provider.
 * Returns normalized SDKMessage format.
 */
export function createStandardScenario(
  sessionId: string,
  response: string,
): MockScenario {
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
          content: response,
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
 * Create a multi-turn conversation scenario.
 */
export function createMultiTurnScenario(
  sessionId: string,
  turns: Array<{ user: string; assistant: string }>,
): MockScenario {
  const messages: SDKMessage[] = [
    {
      type: "system",
      subtype: "init",
      session_id: sessionId,
    },
  ];

  for (const turn of turns) {
    messages.push({
      type: "user",
      session_id: sessionId,
      message: {
        role: "user",
        content: turn.user,
      },
    });
    messages.push({
      type: "assistant",
      session_id: sessionId,
      message: {
        role: "assistant",
        content: turn.assistant,
      },
    });
  }

  messages.push({
    type: "result",
    session_id: sessionId,
  });

  return {
    messages,
    delayMs: 10,
    sessionId,
  };
}

/**
 * Create a tool use scenario that works with any provider.
 */
export function createToolUseScenario(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResult: string,
  finalResponse: string,
): MockScenario {
  const toolUseId = `tool_${Date.now()}`;

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
