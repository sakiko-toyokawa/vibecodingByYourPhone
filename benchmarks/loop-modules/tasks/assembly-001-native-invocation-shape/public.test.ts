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

test("claude provider projects agent_sdk/sdk/print", () => {
  const card = makeCard({ runtime: { provider: "claude" } });
  const input = assembleRuntimeInput(card, makeContract(card));
  assert.equal(input.nativeInvocation.adapter, "claude");
  assert.equal(input.nativeInvocation.bridge, "agent_sdk");
  assert.equal(input.nativeInvocation.surface, "sdk");
  assert.equal(input.nativeInvocation.mode, "print");
  assert.equal(input.nativeInvocation.cwd_ref, "workspace://native-loop");
  assert.equal(input.nativeInvocation.resume_ref, null);
  assert.equal(input.nativeInvocation.timeout_seconds, null);
});

test("codex provider projects app_server/json_rpc/exec", () => {
  const card = makeCard({ runtime: { provider: "codex" } });
  const input = assembleRuntimeInput(card, makeContract(card));
  assert.equal(input.nativeInvocation.adapter, "codex");
  assert.equal(input.nativeInvocation.bridge, "app_server");
  assert.equal(input.nativeInvocation.surface, "json_rpc");
  assert.equal(input.nativeInvocation.mode, "exec");
  assert.equal(input.nativeInvocation.cwd_ref, "workspace://native-loop");
  assert.equal(input.nativeInvocation.resume_ref, null);
  assert.equal(input.nativeInvocation.timeout_seconds, null);
});

test("unknown provider still shapes a native_invocation record for read-only runs", () => {
  const card = makeCard({ runtime: { provider: "gemini" } });
  const input = assembleRuntimeInput(card, makeContract(card));
  assert.equal(input.nativeInvocation.adapter, "gemini");
  assert.equal(input.nativeInvocation.bridge, "acp");
  assert.equal(input.nativeInvocation.mode, "acp");
  assert.equal(input.nativeInvocation.surface, "acp");
  assert.equal(input.nativeInvocation.cwd_ref, "workspace://native-loop");
  assert.equal(input.nativeInvocation.resume_ref, null);
});

test("adapter_policy timeout_seconds is projected into native_invocation", () => {
  const card = makeCard();
  const input = assembleRuntimeInput(card, makeContract(card), [
    {
      proposal_id: "p-timeout",
      type: "runtime_adapter_proposal",
      source_patterns: [],
      summary: "add timeout",
      target: "native-loop.adapter.timeout_config",
      expected_effect: "bounded waits",
      risk: "low",
      validation_plan: "v",
      status: "published",
      created_by: "human",
      payload: { adapter_policy: { timeout_seconds: 600 } },
      created_at: "2026-01-01T00:00:00.000Z",
    },
  ]);
  assert.equal(input.nativeInvocation.timeout_seconds, 600);
  assert.equal(input.nativeInvocation.resume_ref, null);
});

test("mode and bridge are not mixed up", () => {
  const claudeCard = makeCard({ runtime: { provider: "claude" } });
  const claudeInput = assembleRuntimeInput(
    claudeCard,
    makeContract(claudeCard),
  );
  assert.notEqual(claudeInput.nativeInvocation.mode, "exec");

  const codexCard = makeCard({ runtime: { provider: "codex" } });
  const codexInput = assembleRuntimeInput(codexCard, makeContract(codexCard));
  assert.notEqual(codexInput.nativeInvocation.mode, "print");
  assert.notEqual(codexInput.nativeInvocation.bridge, "agent_sdk");
});
