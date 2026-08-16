import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import {
  LOOP_PROPOSAL_BEGIN,
  LOOP_PROPOSAL_END,
  LOOP_PROPOSAL_MAX_TIME_MINUTES,
  LOOP_PROPOSAL_MAX_TURNS,
  clampProposedCard,
  extractLoopProposalPayload,
} from "./loop-proposal.js";

/** 最小合法提案卡（过 LoopCardSchema）。 */
function makeCardJson(overrides: Record<string, unknown> = {}) {
  return {
    loop: {
      id: "daily-codex-triage",
      trigger: { type: "schedule", cron: "0 9 * * *" },
      workspace: { strategy: "direct" },
      verification: { required: ["static"] },
      persistence: { state_file: ".loop/STATE.md" },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 1 },
      handoff: { task: "每天巡检 openai/codex 的新 issue" },
      ...overrides,
    },
  };
}

function makeParentCard(overrides: Record<string, unknown> = {}): LoopCard {
  return {
    loop: {
      id: "parent-loop",
      trigger: { type: "manual" },
      workspace: { strategy: "direct" },
      verification: { required: ["static"] },
      persistence: { state_file: ".loop/STATE.md" },
      stop_rules: { max_turns: 5, max_time_minutes: 60, max_retries: 1 },
      can_propose_loops: true,
      ...overrides,
    },
  } as LoopCard;
}

test("extractLoopProposalPayload parses a valid proposal block", () => {
  const text = [
    "报告正文。",
    LOOP_PROPOSAL_BEGIN,
    JSON.stringify({ card: makeCardJson(), reason: "值得专项跟进" }),
    LOOP_PROPOSAL_END,
    "trailing text",
  ].join("\n");

  const payload = extractLoopProposalPayload(text);
  assert.equal(payload?.reason, "值得专项跟进");
  assert.equal(payload?.card.loop.id, "daily-codex-triage");
  assert.equal(payload?.card.loop.trigger.type, "schedule");
});

test("extractLoopProposalPayload handles a fenced JSON block", () => {
  const text = [
    LOOP_PROPOSAL_BEGIN,
    "```json",
    JSON.stringify({ card: makeCardJson(), reason: "r" }),
    "```",
    LOOP_PROPOSAL_END,
  ].join("\n");

  const payload = extractLoopProposalPayload(text);
  assert.equal(payload?.card.loop.id, "daily-codex-triage");
});

test("extractLoopProposalPayload returns null for missing/invalid blocks", () => {
  assert.equal(extractLoopProposalPayload("no markers"), null);
  assert.equal(
    extractLoopProposalPayload(
      `${LOOP_PROPOSAL_BEGIN}\n{not json}\n${LOOP_PROPOSAL_END}`,
    ),
    null,
  );
  // card 不过 LoopCardSchema（缺 stop_rules）即丢弃
  assert.equal(
    extractLoopProposalPayload(
      `${LOOP_PROPOSAL_BEGIN}\n${JSON.stringify({ card: { loop: { id: "x" } }, reason: "r" })}\n${LOOP_PROPOSAL_END}`,
    ),
    null,
  );
  // 缺 reason 即丢弃
  assert.equal(
    extractLoopProposalPayload(
      `${LOOP_PROPOSAL_BEGIN}\n${JSON.stringify({ card: makeCardJson() })}\n${LOOP_PROPOSAL_END}`,
    ),
    null,
  );
});

test("clampProposedCard forces a managed:// workspace", () => {
  const result = clampProposedCard(
    {
      loop: {
        ...makeCardJson().loop,
        workspace: { strategy: "worktree", path: "/tmp/attacker-checkout" },
      },
    } as LoopCard,
    makeParentCard(),
  );
  assert.equal(result.ok, true);
  assert.equal(
    result.card?.loop.workspace.path,
    "managed://loop-workspaces/daily-codex-triage",
  );
  assert.equal(result.card?.loop.workspace.strategy, "direct");
});

test("clampProposedCard rewrites any managed:// suffix to the canonical path", () => {
  // agent 自带的 managed:// 后缀不可信（managed://../../x 是路径穿越）——
  // 钳制层一律重写为 managed://loop-workspaces/<id>。
  const result = clampProposedCard(
    {
      loop: {
        ...makeCardJson().loop,
        workspace: { strategy: "direct", path: "managed://../../evil" },
      },
    } as LoopCard,
    makeParentCard(),
  );
  assert.equal(result.ok, true);
  assert.equal(
    result.card?.loop.workspace.path,
    "managed://loop-workspaces/daily-codex-triage",
  );
});

test("clampProposedCard rejects non-kebab-case loop ids", () => {
  // id 会被拼进 managed:// 工作区路径与各类 on-disk 目录，
  // 非 kebab-case 一律硬拒绝（"../../etc" 是路径穿越）。
  for (const id of ["../../etc", "Bad_Id", "-leading-dash", "spaces in id"]) {
    const result = clampProposedCard(
      { loop: { ...makeCardJson().loop, id } } as LoopCard,
      makeParentCard(),
    );
    assert.equal(result.ok, false, id);
    assert.ok(
      result.violations.some((v) => v.startsWith("loop_id_not_kebab")),
      id,
    );
  }
});

test("clampProposedCard rejects triggers outside the whitelist", () => {
  const result = clampProposedCard(
    {
      loop: { ...makeCardJson().loop, trigger: { type: "webhook" } },
    } as LoopCard,
    makeParentCard(),
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.violations.some((v) => v.startsWith("trigger_type_not_allowed")),
  );
});

test("clampProposedCard allows manual and cron triggers", () => {
  for (const trigger of [
    { type: "manual" },
    { type: "schedule", cron: "0 9 * * *" },
  ]) {
    const result = clampProposedCard(
      { loop: { ...makeCardJson().loop, trigger } } as LoopCard,
      makeParentCard(),
    );
    assert.equal(result.ok, true, JSON.stringify(trigger));
  }
});

test("clampProposedCard clamps approval_mode wider than the parent's", () => {
  const parent = makeParentCard({
    policy: { approval_mode: "assisted" },
  });
  const wider = clampProposedCard(
    {
      loop: {
        ...makeCardJson().loop,
        policy: { approval_mode: "bypass" },
      },
    } as LoopCard,
    parent,
  );
  assert.equal(wider.ok, true);
  assert.equal(wider.card?.loop.policy?.approval_mode, "assisted");

  // 父 loop 未声明 approval_mode 时按最严 manual 计
  const noParentPolicy = clampProposedCard(
    {
      loop: {
        ...makeCardJson().loop,
        policy: { approval_mode: "full_auto" },
      },
    } as LoopCard,
    makeParentCard(),
  );
  assert.equal(noParentPolicy.ok, true);
  assert.equal(noParentPolicy.card?.loop.policy?.approval_mode, "manual");

  // 不比父 loop 宽的原样保留
  const stricter = clampProposedCard(
    {
      loop: {
        ...makeCardJson().loop,
        policy: { approval_mode: "manual" },
      },
    } as LoopCard,
    parent,
  );
  assert.equal(stricter.card?.loop.policy?.approval_mode, "manual");
});

test("clampProposedCard rejects publish_mode outside the whitelist", () => {
  const result = clampProposedCard(
    {
      loop: {
        ...makeCardJson().loop,
        handoff: { task: "t", publish_mode: "merge" },
      },
    } as unknown as LoopCard,
    makeParentCard(),
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.violations.some((v) => v.startsWith("publish_mode_not_allowed")),
  );
});

test("clampProposedCard caps stop_rules at the global limits", () => {
  const result = clampProposedCard(
    {
      loop: {
        ...makeCardJson().loop,
        stop_rules: {
          max_turns: 999,
          max_time_minutes: 9999,
          max_retries: 2,
        },
      },
    } as LoopCard,
    makeParentCard(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.card?.loop.stop_rules.max_turns, LOOP_PROPOSAL_MAX_TURNS);
  assert.equal(
    result.card?.loop.stop_rules.max_time_minutes,
    LOOP_PROPOSAL_MAX_TIME_MINUTES,
  );
});

test("clampProposedCard writes lineage and strips proposal rights", () => {
  const result = clampProposedCard(
    {
      loop: { ...makeCardJson().loop, can_propose_loops: true },
    } as LoopCard,
    makeParentCard(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.card?.loop.parent_loop_id, "parent-loop");
  // agent 不许自我授予提案权——只有人类能在卡上显式开启
  assert.equal(result.card?.loop.can_propose_loops, false);
});

test("clampProposedCard rejects depth>1 without an explicit human grant", () => {
  const agentCreatedParent = makeParentCard({
    parent_loop_id: "grandparent-loop",
    can_propose_loops: undefined,
  });
  const rejected = clampProposedCard(
    { loop: makeCardJson().loop } as LoopCard,
    agentCreatedParent,
  );
  assert.equal(rejected.ok, false);
  assert.ok(rejected.violations.some((v) => v.startsWith("depth_exceeded")));

  // 人类在 agent 建的卡上显式开 can_propose_loops 后可以提
  const grantedParent = makeParentCard({
    parent_loop_id: "grandparent-loop",
    can_propose_loops: true,
  });
  const allowed = clampProposedCard(
    { loop: makeCardJson().loop } as LoopCard,
    grantedParent,
  );
  assert.equal(allowed.ok, true);
});
