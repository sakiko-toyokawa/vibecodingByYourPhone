import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleRuntimeInput } from "../../../../packages/server/src/loop/assembly/runtime-input.js";
import { buildIntentContract } from "../../../../packages/server/src/loop/contract/intent-contract.js";
import {
  ALL_HARD_GATES,
  resolvePolicyProfile,
} from "../../../../packages/server/src/loop/policy/profiles.js";
import type { LoopCard } from "../../../../packages/shared/src/index.js";

function makeCard(overrides: Partial<LoopCard["loop"]> = {}): LoopCard {
  return {
    loop: {
      id: "policy-loop",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: "/tmp/policy-loop" },
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

test("loop_bypass resolves default risk rules and full bypass scope", () => {
  const card = makeCard({
    policy: { profile: "loop_bypass", approval_mode: "bypass" },
  });
  const profile = resolvePolicyProfile(card);
  assert.equal(profile?.policy_profile, "loop_bypass");
  assert.equal(profile?.approval_mode, "bypass");
  assert.equal(profile?.risk_rules.low, "auto");
  assert.equal(profile?.risk_rules.medium, "auto_if_in_workspace");
  assert.equal(profile?.risk_rules.high, "review_or_policy");
  assert.equal(profile?.risk_rules.critical, "human_required");
  assert.equal(profile?.bypass_scope.allow_workspace_write, true);
  assert.equal(profile?.bypass_scope.allow_local_commands, true);
  assert.deepEqual(profile?.hard_gates, ALL_HARD_GATES);
});

test("loop_strict_review resolves real rule differences", () => {
  const card = makeCard({
    policy: { profile: "loop_strict_review", approval_mode: "bypass" },
  });
  const profile = resolvePolicyProfile(card);
  assert.equal(profile?.policy_profile, "loop_strict_review");
  assert.equal(profile?.risk_rules.medium, "review_or_policy");
  assert.equal(profile?.risk_rules.high, "human_required");
  assert.equal(profile?.risk_rules.low, "auto");
  assert.equal(profile?.bypass_scope.allow_workspace_write, true);
  assert.equal(profile?.bypass_scope.allow_local_commands, false);
});

test("unknown profile name falls back to defaults", () => {
  const card = makeCard({
    policy: { profile: "no_such_profile", approval_mode: "assisted" },
  });
  const profile = resolvePolicyProfile(card);
  assert.equal(profile?.policy_profile, "no_such_profile");
  assert.equal(profile?.risk_rules.medium, "auto_if_in_workspace");
  assert.equal(profile?.risk_rules.high, "review_or_policy");
  assert.equal(profile?.bypass_scope.allow_workspace_write, true);
  assert.equal(profile?.bypass_scope.allow_local_commands, true);
});

test("human_gate.required_for is merged into hard_gates", () => {
  const card = makeCard({
    policy: { profile: "loop_bypass", approval_mode: "bypass" },
    human_gate: { required_for: ["publish"] },
  });
  const profile = resolvePolicyProfile(card);
  assert.ok(profile?.hard_gates.includes("publish"));
  assert.ok(profile?.hard_gates.includes("merge"));
  // duplicate should not inflate array length
  assert.equal(profile?.hard_gates.length, ALL_HARD_GATES.length);
});

test("no policy block resolves to null", () => {
  const card = makeCard();
  assert.equal(resolvePolicyProfile(card), null);
});

test("assembly projects policyProjection for an active policy", () => {
  const card = makeCard({
    policy: { profile: "loop_strict_review", approval_mode: "bypass" },
  });
  const input = assembleRuntimeInput(card, makeContract(card));
  assert.equal(input.permissionMode, "bypassPermissions");
  assert.equal(input.policyProfile?.policy_profile, "loop_strict_review");
  assert.equal(
    input.policyProjection?.policy_intent_ref,
    "policy://loop_strict_review",
  );
  assert.equal(
    input.policyProjection?.approval_or_permission_mode,
    "bypass_self_approve_with_audit",
  );
  assert.deepEqual(input.policyProjection?.allowed_tools, []);
  assert.deepEqual(input.policyProjection?.disallowed_tools, []);
  assert.ok(input.policyProjection?.hard_gates.includes("merge"));
});
