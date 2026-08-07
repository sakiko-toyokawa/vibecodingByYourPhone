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

test("gemini provider with active policy throws AssemblyError", () => {
  const card = makeCard({
    policy: { profile: "loop_bypass", approval_mode: "bypass" },
    runtime: { provider: "gemini" },
  });
  assert.throws(
    () => assembleRuntimeInput(card, makeContract(card)),
    (error: unknown) =>
      error instanceof AssemblyError &&
      /cannot enforce it/.test((error as Error).message),
  );
});

test("claude provider with active policy is accepted", () => {
  const card = makeCard({
    policy: { profile: "loop_bypass", approval_mode: "bypass" },
    runtime: { provider: "claude" },
  });
  const input = assembleRuntimeInput(card, makeContract(card));
  assert.equal(input.permissionMode, "bypassPermissions");
  assert.equal(input.policyProfile?.policy_profile, "loop_bypass");
});

test("codex provider with active policy is accepted", () => {
  const card = makeCard({
    policy: { profile: "loop_bypass", approval_mode: "bypass" },
    runtime: { provider: "codex" },
  });
  const input = assembleRuntimeInput(card, makeContract(card));
  assert.equal(input.permissionMode, "bypassPermissions");
  assert.equal(input.nativeInvocation.bridge, "app_server");
});

test("legacy read-only card never triggers the guard", () => {
  const card = makeCard({ runtime: { provider: "gemini" } });
  const input = assembleRuntimeInput(card, makeContract(card));
  assert.equal(input.permissionMode, "plan");
  assert.equal(input.policyProfile, undefined);
});

test("manual approval_mode never triggers the guard", () => {
  const card = makeCard({
    policy: { profile: "loop_bypass", approval_mode: "manual" },
    runtime: { provider: "gemini" },
  });
  const input = assembleRuntimeInput(card, makeContract(card));
  assert.equal(input.permissionMode, "plan");
});
