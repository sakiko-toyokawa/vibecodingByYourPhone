/**
 * Mock Gemini provider for testing.
 *
 * Simulates Gemini CLI behavior without requiring the CLI or API keys.
 * Normalizes Gemini-specific message formats to SDKMessage format.
 */

import type { SDKMessage } from "../../types.js";
import type { ProviderName } from "../types.js";
import { BaseMockProvider } from "./base.js";
import type { MockProviderConfig, MockScenario } from "./types.js";

/**
 * Mock Gemini provider.
 * Extends BaseMockProvider with Gemini-specific defaults.
 */
export class MockGeminiProvider extends BaseMockProvider {
  readonly name: ProviderName = "gemini";
  readonly displayName = "Gemini";

  constructor(config: MockProviderConfig = {}) {
    super(config);
  }
}

/**
 * Mock Gemini ACP provider.
 * Same as MockGeminiProvider but for ACP mode.
 */
export class MockGeminiACPProvider extends BaseMockProvider {
  readonly name: ProviderName = "gemini-acp";
  readonly displayName = "Gemini (ACP)";

  constructor(config: MockProviderConfig = {}) {
    super(config);
  }
}

/**
 * Create a simple Gemini response scenario.
 * Messages are already normalized to SDKMessage format.
 */
export function createGeminiScenario(
  sessionId: string,
  assistantResponse: string,
  options: { delayMs?: number; includeThoughts?: boolean } = {},
): MockScenario {
  const messages: SDKMessage[] = [
    {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: "gemini-2.0-flash",
    },
  ];

  if (options.includeThoughts) {
    // Gemini's "thoughts" are converted to thinking blocks
    messages.push({
      type: "assistant",
      session_id: sessionId,
      message: {
        role: "assistant",
        content:
          "<thinking>\n[Analysis] Processing the request...\n</thinking>",
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
      input_tokens: 80,
      output_tokens: 40,
    },
  });

  return {
    messages,
    delayMs: options.delayMs ?? 10,
    sessionId,
  };
}

/**
 * Create a Gemini tool use scenario.
 * Uses functionCall format normalized to tool_use.
 */
export function createGeminiToolScenario(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResult: string,
  finalResponse: string,
): MockScenario {
  const toolUseId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  return {
    messages: [
      {
        type: "system",
        subtype: "init",
        session_id: sessionId,
        model: "gemini-2.0-flash",
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
          input_tokens: 150,
          output_tokens: 80,
        },
      },
    ],
    delayMs: 10,
    sessionId,
  };
}

/**
 * Create a Gemini scenario with thoughts (reasoning).
 */
export function createGeminiThoughtsScenario(
  sessionId: string,
  thoughts: Array<{ subject?: string; description?: string }>,
  finalResponse: string,
): MockScenario {
  const thoughtsText = thoughts
    .map((t) => {
      const parts: string[] = [];
      if (t.subject) parts.push(`[${t.subject}]`);
      if (t.description) parts.push(t.description);
      return parts.join(" ");
    })
    .join("\n");

  return {
    messages: [
      {
        type: "system",
        subtype: "init",
        session_id: sessionId,
        model: "gemini-2.0-flash",
      },
      {
        type: "assistant",
        session_id: sessionId,
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `<thinking>\n${thoughtsText}\n</thinking>`,
            },
            {
              type: "text",
              text: finalResponse,
            },
          ],
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
 * Create a Gemini error scenario.
 */
export function createGeminiErrorScenario(
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
