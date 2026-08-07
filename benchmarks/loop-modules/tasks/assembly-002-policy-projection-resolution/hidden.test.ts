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

test("manual approval_mode still resolves a profile", () => {
  const card = makeCard({
    policy: { profile: "loop_strict_review", approval_mode: "manual" },
  });
  const profile = resolvePolicyProfile(card);
  assert.equal(profile?.policy_profile, "loop_strict_review");
  assert.equal(profile?.approval_mode, "manual");
  assert.equal(profile?.risk_rules.medium, "review_or_policy");
});

test("named profiles include github_issue_local_fix and workspace_local_fix", () => {
  const gh = makeCard({
    policy: { profile: "github_issue_local_fix", approval_mode: "bypass" },
  });
  const ghProfile = resolvePolicyProfile(gh);
  assert.equal(ghProfile?.policy_profile, "github_issue_local_fix");
  assert.deepEqual(ghProfile?.hard_gates, ALL_HARD_GATES);

  const ws = makeCard({
    policy: { profile: "workspace_local_fix", approval_mode: "bypass" },
  });
  const wsProfile = resolvePolicyProfile(ws);
  assert.equal(wsProfile?.policy_profile, "workspace_local_fix");
  assert.equal(wsProfile?.bypass_scope.allow_local_commands, true);
});

test("profile override from proposal resolves through the registry", () => {
  const card = makeCard({
    policy: { profile: "loop_bypass", approval_mode: "bypass" },
  });
  const profile = resolvePolicyProfile(card, "loop_strict_review");
  assert.equal(profile?.policy_profile, "loop_strict_review");
  assert.equal(profile?.risk_rules.medium, "review_or_policy");
  assert.equal(profile?.bypass_scope.allow_local_commands, false);
});

test("policyProjection sandbox reflects the actual bridge", () => {
  const claudeCard = makeCard({
    policy: { profile: "loop_bypass", approval_mode: "bypass" },
    runtime: { provider: "claude" },
  });
  const claudeInput = assembleRuntimeInput(
    claudeCard,
    makeContract(claudeCard),
  );
  assert.equal(claudeInput.policyProjection?.sandbox, "none");

  const codexCard = makeCard({
    policy: { profile: "loop_bypass", approval_mode: "bypass" },
    runtime: { provider: "codex" },
  });
  const codexInput = assembleRuntimeInput(codexCard, makeContract(codexCard));
  assert.equal(codexInput.policyProjection?.sandbox, "read-only");
});

test("a custom human_gate word outside the canonical seven is preserved", () => {
  const card = makeCard({
    policy: { profile: "loop_bypass", approval_mode: "bypass" },
    human_gate: { required_for: ["push"] },
  });
  const profile = resolvePolicyProfile(card);
  assert.ok(profile?.hard_gates.includes("push"));
  assert.equal(profile?.hard_gates.length, ALL_HARD_GATES.length + 1);
});
