import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProposalEffects } from "../../../../packages/server/src/loop/assembly/proposal-effects.js";
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

test("published memory_packet_template applies globally", () => {
  const effects = resolveProposalEffects("loop-other", [
    makeProposal({ payload: { memory_packet_template: "T" } }),
  ]);
  assert.equal(effects.memoryPacketTemplate, "T");
});

test("canary only applies to marked loops", () => {
  const proposal = makeProposal({
    proposal_id: "c1",
    status: "canary",
    payload: { memory_packet_template: "T", canary_loops: ["loop-1"] },
  });
  assert.equal(
    resolveProposalEffects("loop-1", [proposal]).memoryPacketTemplate,
    "T",
  );
  assert.equal(
    resolveProposalEffects("loop-2", [proposal]).memoryPacketTemplate,
    undefined,
  );
});

test("draft / shadow / approved / rolled_back / rejected are ignored", () => {
  const template = { payload: { memory_packet_template: "T" } };
  const ignored = [
    "draft",
    "shadow",
    "approved",
    "rolled_back",
    "rejected",
  ] as const;
  for (const status of ignored) {
    const effects = resolveProposalEffects("loop-1", [
      makeProposal({ status, ...template }),
    ]);
    assert.equal(
      effects.memoryPacketTemplate,
      undefined,
      `${status} must not be consumed`,
    );
  }
});

test("rollback reverts to the previous published version", () => {
  const older = makeProposal({
    proposal_id: "v1",
    created_at: T0,
    payload: { memory_packet_template: "旧模板" },
  });
  const newer = makeProposal({
    proposal_id: "v2",
    created_at: T1,
    payload: { memory_packet_template: "新模板" },
  });
  assert.equal(
    resolveProposalEffects("loop-1", [older, newer]).memoryPacketTemplate,
    "新模板",
  );

  const rolledBack = { ...newer, status: "rolled_back" as const };
  const effects: ProposalEffects = resolveProposalEffects("loop-1", [
    older,
    rolledBack,
  ]);
  assert.equal(effects.memoryPacketTemplate, "旧模板");
  assert.deepEqual(
    effects.applied.map((a) => a.proposal_id),
    ["v1"],
  );
});

test("memory packet template is injected into the assembled prompt", () => {
  const card = makeCard();
  const input = assembleRuntimeInput(card, makeContract(card), [
    makeProposal({
      proposal_id: "p-template",
      payload: { memory_packet_template: "pnpm workspace 规则摘要" },
    }),
  ]);
  assert.match(input.prompt, /Memory packet（已发布改进提案）：/);
  assert.match(input.prompt, /pnpm workspace 规则摘要/);
  assert.deepEqual(input.appliedProposals?.sort(), ["p-template"]);
});

test("runtime_adapter_proposal projects timeout_seconds", () => {
  const card = makeCard();
  const input = assembleRuntimeInput(card, makeContract(card), [
    makeProposal({
      proposal_id: "p-adapter",
      type: "runtime_adapter_proposal",
      target: "loop-1.adapter.timeout_config",
      payload: { adapter_policy: { timeout_seconds: 900 } },
    }),
  ]);
  assert.equal(input.nativeInvocation.timeout_seconds, 900);
  assert.deepEqual(input.adapterPolicy, { timeout_seconds: 900 });
  assert.deepEqual(input.appliedProposals?.sort(), ["p-adapter"]);
});

test("policy_profile_proposal overrides the resolved profile only in policy mode", () => {
  const card = makeCard({
    policy: { profile: "loop_bypass", approval_mode: "bypass" },
  });
  const input = assembleRuntimeInput(card, makeContract(card), [
    makeProposal({
      proposal_id: "p-profile",
      type: "policy_profile_proposal",
      target: "loop-1.policy_profile",
      payload: { policy_profile: "loop_strict_review" },
    }),
  ]);
  assert.equal(input.policyProfile?.policy_profile, "loop_strict_review");
  assert.equal(input.policyProfile?.risk_rules.medium, "review_or_policy");

  // Without a policy block the same proposal is ignored.
  const legacyCard = makeCard();
  const legacyInput = assembleRuntimeInput(
    legacyCard,
    makeContract(legacyCard),
    [
      makeProposal({
        proposal_id: "p-profile",
        type: "policy_profile_proposal",
        target: "loop-1.policy_profile",
        payload: { policy_profile: "loop_strict_review" },
      }),
    ],
  );
  assert.equal(legacyInput.policyProfile, undefined);
  assert.equal(legacyInput.permissionMode, "plan");
});
