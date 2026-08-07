import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AssemblyError,
  assembleRuntimeInput,
} from "../../../../packages/server/src/loop/assembly/runtime-input.js";
import { buildIntentContract } from "../../../../packages/server/src/loop/contract/intent-contract.js";
import type { LoopCard } from "../../../../packages/shared/src/index.js";

function makeCard(overrides: Partial<LoopCard["loop"]> = {}): LoopCard {
  return {
    loop: {
      id: "guard-loop",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: "/tmp/guard-loop" },
      verification: { required: [] },
      persistence: { state_file: ".loop/STATE.md" },
      stop_rules: { max_turns: 3, max_time_minutes: 10, max_retries: 2 },
      ...overrides,
    },
  };
}

function makeContract(card: LoopCard) {
  return buildIntentContract(card, { runId: "run-1", source: "manual" });
}

test("claude-ollama and codex-oss are accepted", () => {
  const coll = makeCard({
    policy: { profile: "loop_bypass", approval_mode: "bypass" },
    runtime: { provider: "claude-ollama" },
  });
  const collInput = assembleRuntimeInput(coll, makeContract(coll));
  assert.equal(collInput.permissionMode, "bypassPermissions");

  const coss = makeCard({
    policy: { profile: "loop_bypass", approval_mode: "bypass" },
    runtime: { provider: "codex-oss" },
  });
  const cossInput = assembleRuntimeInput(coss, makeContract(coss));
  assert.equal(cossInput.permissionMode, "bypassPermissions");
});

test("openai provider with active policy throws", () => {
  const card = makeCard({
    policy: { profile: "loop_bypass", approval_mode: "bypass" },
    runtime: { provider: "openai" },
  });
  assert.throws(
    () => assembleRuntimeInput(card, makeContract(card)),
    (error: unknown) =>
      error instanceof AssemblyError &&
      /cannot enforce it/.test((error as Error).message),
  );
});

test("error message identifies loop, approval_mode, and provider", () => {
  const card = makeCard({
    policy: { profile: "loop_bypass", approval_mode: "full_auto" },
    runtime: { provider: "gemini" },
  });
  let message = "";
  try {
    assembleRuntimeInput(card, makeContract(card));
  } catch (error) {
    message = (error as Error).message;
  }
  assert.match(message, /guard-loop/);
  assert.match(message, /full_auto/);
  assert.match(message, /gemini/);
});

test("adapter_policy proposal does not bypass the provider guard", () => {
  const card = makeCard({
    policy: { profile: "loop_bypass", approval_mode: "bypass" },
    runtime: { provider: "gemini" },
  });
  assert.throws(
    () =>
      assembleRuntimeInput(card, makeContract(card), [
        {
          proposal_id: "p-bypass",
          type: "runtime_adapter_proposal",
          source_patterns: [],
          summary: "bypass",
          target: "guard-loop.adapter.timeout_config",
          expected_effect: "e",
          risk: "low",
          validation_plan: "v",
          status: "published",
          created_by: "human",
          payload: { adapter_policy: { timeout_seconds: 10 } },
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ]),
    (error: unknown) => error instanceof AssemblyError,
  );
});
