import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleRuntimeInput } from "../../../../packages/server/src/loop/assembly/runtime-input.js";
import { buildIntentContract } from "../../../../packages/server/src/loop/contract/intent-contract.js";
import type { LoopCard } from "../../../../packages/shared/src/index.js";

function makeCard(overrides: Partial<LoopCard["loop"]> = {}): LoopCard {
  return {
    loop: {
      id: "native-loop",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: "/tmp/native-loop" },
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

test("default provider (no runtime.provider) is claude", () => {
  const card = makeCard();
  const input = assembleRuntimeInput(card, makeContract(card));
  assert.equal(input.nativeInvocation.adapter, "claude");
  assert.equal(input.nativeInvocation.bridge, "agent_sdk");
  assert.equal(input.nativeInvocation.mode, "print");
});

test("claude-ollama and codex-oss variants project correctly", () => {
  const claudeOllama = makeCard({ runtime: { provider: "claude-ollama" } });
  const co = assembleRuntimeInput(claudeOllama, makeContract(claudeOllama));
  assert.equal(co.nativeInvocation.adapter, "claude-ollama");
  assert.equal(co.nativeInvocation.bridge, "agent_sdk");
  assert.equal(co.nativeInvocation.mode, "print");

  const codexOss = makeCard({ runtime: { provider: "codex-oss" } });
  const coss = assembleRuntimeInput(codexOss, makeContract(codexOss));
  assert.equal(coss.nativeInvocation.adapter, "codex-oss");
  assert.equal(coss.nativeInvocation.bridge, "app_server");
  assert.equal(coss.nativeInvocation.mode, "exec");
});

test("fractional timeout_seconds is rounded to whole milliseconds and back", () => {
  const card = makeCard();
  const input = assembleRuntimeInput(card, makeContract(card), [
    {
      proposal_id: "p-frac",
      type: "runtime_adapter_proposal",
      source_patterns: [],
      summary: "fractional timeout",
      target: "native-loop.adapter.timeout_config",
      expected_effect: "e",
      risk: "low",
      validation_plan: "v",
      status: "published",
      created_by: "human",
      payload: { adapter_policy: { timeout_seconds: 1.234999 } },
      created_at: "2026-01-01T00:00:00.000Z",
    },
  ]);
  assert.equal(input.nativeInvocation.timeout_seconds, 1.235);
});

test("non-positive or malformed timeout_seconds is ignored", () => {
  const card = makeCard();
  const input = assembleRuntimeInput(card, makeContract(card), [
    {
      proposal_id: "p-bad",
      type: "runtime_adapter_proposal",
      source_patterns: [],
      summary: "bad timeout",
      target: "native-loop.adapter.timeout_config",
      expected_effect: "e",
      risk: "low",
      validation_plan: "v",
      status: "published",
      created_by: "human",
      payload: { adapter_policy: { timeout_seconds: -10 } },
      created_at: "2026-01-01T00:00:00.000Z",
    },
  ]);
  assert.equal(input.nativeInvocation.timeout_seconds, null);
});

test("resume_ref is always null for the turn-1 bundle even with adapter_policy", () => {
  const card = makeCard({ runtime: { provider: "codex" } });
  const input = assembleRuntimeInput(card, makeContract(card), [
    {
      proposal_id: "p-timeout",
      type: "runtime_adapter_proposal",
      source_patterns: [],
      summary: "timeout",
      target: "native-loop.adapter.timeout_config",
      expected_effect: "e",
      risk: "low",
      validation_plan: "v",
      status: "published",
      created_by: "human",
      payload: { adapter_policy: { timeout_seconds: 300 } },
      created_at: "2026-01-01T00:00:00.000Z",
    },
  ]);
  assert.equal(input.nativeInvocation.resume_ref, null);
});
