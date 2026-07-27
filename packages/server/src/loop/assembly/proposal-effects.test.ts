import assert from "node:assert/strict";
import { test } from "node:test";
import type { ImprovementProposal, LoopCard } from "@yep-anywhere/shared";
import { buildIntentContract } from "../contract/intent-contract.js";
import { resolveProposalEffects } from "./proposal-effects.js";
import { assembleRuntimeInput } from "./runtime-input.js";

const T0 = "2026-07-24T10:00:00.000Z";
const T1 = "2026-07-24T11:00:00.000Z";

function makeProposal(
  id: string,
  overrides: Partial<ImprovementProposal> = {},
): ImprovementProposal {
  return {
    proposal_id: id,
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
  };
}

function makeCard(overrides: Partial<LoopCard["loop"]> = {}): LoopCard {
  return {
    loop: {
      id: "loop-1",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: "/tmp/target" },
      verification: { required: [] },
      persistence: { state_file: ".loop/STATE.md" },
      stop_rules: { max_turns: 3, max_time_minutes: 10, max_retries: 2 },
      ...overrides,
    },
  } as LoopCard;
}

function makeContract(card: LoopCard) {
  return buildIntentContract(card, { runId: "run-1", source: "manual" });
}

// --- resolveProposalEffects 生效规则 ---

test("published 全量生效; draft / shadow / approved / rolled_back / rejected 不消费", () => {
  const template = { payload: { memory_packet_template: "T" } };
  const statuses = [
    "draft",
    "shadow",
    "approved",
    "rolled_back",
    "rejected",
  ] as const;
  for (const status of statuses) {
    const effects = resolveProposalEffects("loop-1", [
      makeProposal("p", { status, ...template }),
    ]);
    assert.equal(
      effects.memoryPacketTemplate,
      undefined,
      `${status} 不得被装配消费`,
    );
  }
  // published 对任意 loop 生效 (全量)
  const published = resolveProposalEffects("loop-other", [
    makeProposal("p", { ...template }),
  ]);
  assert.equal(published.memoryPacketTemplate, "T");
});

test("canary 只对打了标记的 loop 生效 (canary_loops 或 target 前缀按 loop_id 匹配)", () => {
  const viaLoops = makeProposal("c1", {
    status: "canary",
    target: "memory_packet_template",
    payload: {
      memory_packet_template: "T",
      canary_loops: ["loop-1"],
    },
  });
  assert.equal(
    resolveProposalEffects("loop-1", [viaLoops]).memoryPacketTemplate,
    "T",
  );
  assert.equal(
    resolveProposalEffects("loop-2", [viaLoops]).memoryPacketTemplate,
    undefined,
  );

  const viaTarget = makeProposal("c2", {
    status: "canary",
    payload: { memory_packet_template: "T2" },
  });
  assert.equal(
    resolveProposalEffects("loop-1", [viaTarget]).memoryPacketTemplate,
    "T2",
  );
  assert.equal(
    resolveProposalEffects("loop-2", [viaTarget]).memoryPacketTemplate,
    undefined,
  );
});

test("版本与回滚: 同槽位取最新 published; 最新 rolled_back 后旧版本回补", () => {
  const older = makeProposal("v1", {
    created_at: T0,
    payload: { memory_packet_template: "旧模板" },
  });
  const newer = makeProposal("v2", {
    created_at: T1,
    payload: { memory_packet_template: "新模板" },
  });
  assert.equal(
    resolveProposalEffects("loop-1", [older, newer]).memoryPacketTemplate,
    "新模板",
  );
  // 最新版本 rolled_back → 旧 published 版本重新生效 (版本记录不删)
  const rolledBackNewer = { ...newer, status: "rolled_back" as const };
  const effects = resolveProposalEffects("loop-1", [older, rolledBackNewer]);
  assert.equal(effects.memoryPacketTemplate, "旧模板");
  assert.deepEqual(
    effects.applied.map((a) => a.proposal_id),
    ["v1"],
  );
});

// --- assembleRuntimeInput 装配消费 ---

test("装配: published 提案内容进入 RuntimeInput (prompt / adapterPolicy / appliedProposals)", () => {
  const card = makeCard();
  const input = assembleRuntimeInput(card, makeContract(card), [
    makeProposal("p-template", {
      payload: { memory_packet_template: "pnpm workspace 规则摘要..." },
    }),
    makeProposal("p-adapter", {
      type: "runtime_adapter_proposal",
      target: "loop-1.adapter.timeout_config",
      created_at: T1,
      payload: { adapter_policy: { timeout_ms: 60_000 } },
    }),
  ]);
  assert.match(input.prompt, /Memory packet（已发布改进提案）：/);
  assert.match(input.prompt, /pnpm workspace 规则摘要/);
  assert.deepEqual(input.adapterPolicy, { timeout_ms: 60_000 });
  assert.deepEqual(input.appliedProposals?.sort(), ["p-adapter", "p-template"]);
});

test("装配: policy_profile_proposal 覆盖策略档名 (仅策略投影模式)", () => {
  const card = makeCard({
    policy: { profile: "loop_bypass", approval_mode: "bypass" },
  });
  const input = assembleRuntimeInput(card, makeContract(card), [
    makeProposal("p-profile", {
      type: "policy_profile_proposal",
      target: "loop-1.policy_profile",
      payload: { policy_profile: "loop_strict_v2" },
    }),
  ]);
  assert.equal(input.policyProfile?.policy_profile, "loop_strict_v2");
  assert.match(input.prompt, /loop_strict_v2/);

  // 无 policy 块的 card: 单个提案不开启策略管线
  const legacyCard = makeCard();
  const legacyInput = assembleRuntimeInput(
    legacyCard,
    makeContract(legacyCard),
    [
      makeProposal("p-profile", {
        type: "policy_profile_proposal",
        target: "loop-1.policy_profile",
        payload: { policy_profile: "loop_strict_v2" },
      }),
    ],
  );
  assert.equal(legacyInput.policyProfile, undefined);
  assert.equal(legacyInput.permissionMode, "plan");
});

test("装配: 无提案 / 无可消费提案时行为与阶段 2 一致", () => {
  const card = makeCard();
  const withoutProposals = assembleRuntimeInput(card, makeContract(card));
  const withIgnored = assembleRuntimeInput(card, makeContract(card), [
    makeProposal("p-draft", { status: "draft" }),
  ]);
  assert.equal(withoutProposals.prompt, withIgnored.prompt);
  assert.equal(withoutProposals.adapterPolicy, undefined);
  assert.equal(withoutProposals.appliedProposals, undefined);
});
