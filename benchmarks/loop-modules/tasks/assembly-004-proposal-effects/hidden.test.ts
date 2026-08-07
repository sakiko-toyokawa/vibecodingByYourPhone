import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAdapterPolicy } from "../../../../packages/server/src/loop/assembly/adapter-policy.js";
import { resolveProposalEffects } from "../../../../packages/server/src/loop/assembly/proposal-effects.js";
import { assembleRuntimeInput } from "../../../../packages/server/src/loop/assembly/runtime-input.js";
import { buildIntentContract } from "../../../../packages/server/src/loop/contract/intent-contract.js";
import type {
  ImprovementProposal,
  LoopCard,
} from "../../../../packages/shared/src/index.js";

const T0 = "2026-07-24T10:00:00.000Z";
const T1 = "2026-07-24T11:00:00.000Z";

function makeProposal(
  overrides: Partial<ImprovementProposal> = {},
): ImprovementProposal {
  return {
    proposal_id: "p",
    type: "memory_packet_template_proposal",
    source_patterns: ["fp-1"],
    summary: "s",
    target: "loop-1.memory_packet_template",
    expected_effect: "e",
    risk: "low",
    validation_plan: "v",
    status: "published",
    created_by: "worker",
    created_at: T0,
    ...overrides,
  } as ImprovementProposal;
}

function makeCard(overrides: Partial<LoopCard["loop"]> = {}): LoopCard {
  return {
    loop: {
      id: "loop-1",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: "/tmp/loop-1" },
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

test("canary applies via target prefix when canary_loops is absent", () => {
  const proposal = makeProposal({
    proposal_id: "c2",
    status: "canary",
    target: "loop-1.memory_packet_template",
    payload: { memory_packet_template: "T2" },
  });
  assert.equal(
    resolveProposalEffects("loop-1", [proposal]).memoryPacketTemplate,
    "T2",
  );
  assert.equal(
    resolveProposalEffects("loop-2", [proposal]).memoryPacketTemplate,
    undefined,
  );
});

test("rolled_back newest with no older published leaves slot empty", () => {
  const only = makeProposal({
    proposal_id: "v1",
    status: "rolled_back",
    payload: { memory_packet_template: "Gone" },
  });
  const effects = resolveProposalEffects("loop-1", [only]);
  assert.equal(effects.memoryPacketTemplate, undefined);
  assert.deepEqual(effects.applied, []);
});

test("multiple proposal slots can apply in the same assembly", () => {
  const card = makeCard({
    policy: { profile: "loop_bypass", approval_mode: "bypass" },
  });
  const input = assembleRuntimeInput(card, makeContract(card), [
    makeProposal({
      proposal_id: "p-template",
      payload: { memory_packet_template: "M" },
    }),
    makeProposal({
      proposal_id: "p-adapter",
      type: "runtime_adapter_proposal",
      target: "loop-1.adapter.timeout_config",
      created_at: T1,
      payload: { adapter_policy: { timeout_seconds: 120 } },
    }),
    makeProposal({
      proposal_id: "p-profile",
      type: "policy_profile_proposal",
      target: "loop-1.policy_profile",
      created_at: T1,
      payload: { policy_profile: "loop_strict_review" },
    }),
  ]);
  assert.match(input.prompt, /M/);
  assert.equal(input.nativeInvocation.timeout_seconds, 120);
  assert.equal(input.policyProfile?.policy_profile, "loop_strict_review");
  assert.deepEqual(input.appliedProposals?.sort(), [
    "p-adapter",
    "p-profile",
    "p-template",
  ]);
});

test("adapter_policy raw payload is preserved on RuntimeInput, ignored keys are reported", () => {
  const card = makeCard();
  const raw = { timeout_seconds: 60, unknown_key: 42 };
  const input = assembleRuntimeInput(card, makeContract(card), [
    makeProposal({
      proposal_id: "p-raw",
      type: "runtime_adapter_proposal",
      target: "loop-1.adapter.timeout_config",
      payload: { adapter_policy: raw },
    }),
  ]);
  assert.deepEqual(input.adapterPolicy, raw);
  const resolved = resolveAdapterPolicy(raw);
  assert.equal(resolved.timeoutMs, 60_000);
  assert.deepEqual(resolved.ignoredKeys, ["unknown_key"]);
});

test("policy_profile override resolves real rule differences from registry", () => {
  const card = makeCard({
    policy: { profile: "loop_bypass", approval_mode: "bypass" },
  });
  const input = assembleRuntimeInput(card, makeContract(card), [
    makeProposal({
      proposal_id: "p-strict",
      type: "policy_profile_proposal",
      target: "loop-1.policy_profile",
      payload: { policy_profile: "loop_strict_review" },
    }),
  ]);
  assert.equal(input.policyProfile?.risk_rules.medium, "review_or_policy");
  assert.equal(input.policyProfile?.bypass_scope.allow_local_commands, false);
});
