/**
 * Fixture loader for mock provider tests.
 *
 * Loads JSONL and JSON fixture files and converts them to MockScenario format.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MockScenario } from "../../src/sdk/providers/__mocks__/types.js";
import type { SDKMessage } from "../../src/sdk/types.js";

const FIXTURES_DIR = join(__dirname);

/**
 * Load a fixture file by provider and name.
 *
 * @param provider - The provider name (claude, codex, gemini)
 * @param name - The fixture name (without extension)
 * @returns MockScenario from the fixture
 */
export function loadFixture(provider: string, name: string): MockScenario {
  // Try JSONL first, then JSON
  const jsonlPath = join(FIXTURES_DIR, provider, `${name}.jsonl`);
  const jsonPath = join(FIXTURES_DIR, provider, `${name}.json`);

  let content: string;
  let isJsonl = true;

  try {
    content = readFileSync(jsonlPath, "utf-8");
  } catch {
    try {
      content = readFileSync(jsonPath, "utf-8");
      isJsonl = false;
    } catch {
      throw new Error(`Fixture not found: ${provider}/${name}`);
    }
  }

  const messages = parseContent(content, isJsonl);
  const sessionId = extractSessionId(messages);

  return {
    messages,
    delayMs: 10,
    sessionId,
  };
}

/**
 * Load a fixture file by path.
 */
export function loadFixtureByPath(fixturePath: string): MockScenario {
  const fullPath = join(FIXTURES_DIR, fixturePath);
  const content = readFileSync(fullPath, "utf-8");
  const isJsonl = fixturePath.endsWith(".jsonl");

  const messages = parseContent(content, isJsonl);
  const sessionId = extractSessionId(messages);

  return {
    messages,
    delayMs: 10,
    sessionId,
  };
}

/**
 * Parse file content to messages.
 */
function parseContent(content: string, isJsonl: boolean): SDKMessage[] {
  if (isJsonl) {
    return content
      .trim()
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  }
  // JSON format - each line is a separate JSON object
  return content
    .trim()
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/**
 * Extract session ID from messages.
 */
function extractSessionId(messages: SDKMessage[]): string | undefined {
  for (const msg of messages) {
    if (msg.session_id) return msg.session_id;
  }
  return undefined;
}

/**
 * Get all available fixtures for a provider.
 */
export function getProviderFixtures(provider: string): string[] {
  const providerDir = join(FIXTURES_DIR, provider);
  const fs = require("node:fs");

  try {
    const files = fs.readdirSync(providerDir);
    return files
      .filter((f: string) => f.endsWith(".jsonl") || f.endsWith(".json"))
      .map((f: string) => f.replace(/\.(jsonl?|json)$/, ""));
  } catch {
    return [];
  }
}
