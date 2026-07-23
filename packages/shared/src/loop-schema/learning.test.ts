import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FailurePatternSchema,
  ImprovementProposalSchema,
  LearningEventSchema,
  ProposalPipelineStageSchema,
} from "./learning.js";

/** 02 §8.4 完整示例 + 扩展字段 loop_id */
const VALID_LEARNING_EVENT = {
  event_id: "learn_evt_123",
  run_id: "run_20260720_001",
  loop_id: "loop_ci_fix",
  decision: "retry",
  judgment_ref: "artifact://judgment-report.json",
  ledger_refs: [
    "ledger://run_20260720_001",
    "ledger://decision-run_20260720_001",
  ],
  failure_tags: ["tool_error", "context_error"],
  created_at: "2026-07-20T10:05:00Z",
};

/** 02 §8.3 完整示例 + 扩展字段 signature/occurrence_count/首末次时间 */
const VALID_FAILURE_PATTERN = {
  pattern_id: "fp_ci_retry_loop",
  type: "context_error",
  summary: "CI 修复任务反复缺少 pnpm workspace 规则",
  signature: "context_error:ci:missing-pnpm-workspace-rules",
  occurrence_count: 3,
  first_seen_at: "2026-07-18T09:00:00Z",
  last_seen_at: "2026-07-20T10:05:00Z",
  evidence_runs: ["run_001", "run_004", "run_009"],
  affected_loop_specs: ["loop_ci_fix"],
  suggested_action: "proposal_required",
  status: "open",
};

/** 02 §8.5 完整示例 + 扩展字段 created_by */
const VALID_PROPOSAL = {
  proposal_id: "prop_20260720_001",
  type: "memory_packet_template_proposal",
  source_patterns: ["fp_ci_retry_loop"],
  summary: "CI 修复任务应注入 pnpm workspace 规则摘要",
  target: "loop_ci_fix.memory_packet_template",
  expected_effect: "减少同类 context_error",
  risk: "medium",
  validation_plan: "在 CI golden tasks 上 shadow + canary",
  status: "draft",
  created_by: "worker",
  created_at: "2026-07-20T11:00:00Z",
};

test("LearningEventSchema: 正例（02 §8.4 示例）", () => {
  const parsed = LearningEventSchema.parse(VALID_LEARNING_EVENT);
  assert.equal(parsed.run_id, "run_20260720_001");
  assert.deepEqual(parsed.failure_tags, ["tool_error", "context_error"]);
});

test("LearningEventSchema: failure_tags 空数组合法（无明显失败标签）", () => {
  const parsed = LearningEventSchema.parse({
    ...VALID_LEARNING_EVENT,
    decision: "complete",
    failure_tags: [],
  });
  assert.deepEqual(parsed.failure_tags, []);
});

test("LearningEventSchema: 反例 — failure_tags 不是 8 值归因词汇", () => {
  const result = LearningEventSchema.safeParse({
    ...VALID_LEARNING_EVENT,
    failure_tags: ["unknown_error"],
  });
  assert.equal(result.success, false);
});

test("LearningEventSchema: 反例 — decision 不在 decision_entry 枚举内", () => {
  const result = LearningEventSchema.safeParse({
    ...VALID_LEARNING_EVENT,
    decision: "explode",
  });
  assert.equal(result.success, false);
});

test("LearningEventSchema: 反例 — 缺 run_id / created_at 非 datetime", () => {
  const { run_id: _omit, ...missingRunId } = VALID_LEARNING_EVENT;
  assert.equal(LearningEventSchema.safeParse(missingRunId).success, false);
  assert.equal(
    LearningEventSchema.safeParse({
      ...VALID_LEARNING_EVENT,
      created_at: "yesterday",
    }).success,
    false,
  );
});

test("FailurePatternSchema: 正例（02 §8.3 示例）", () => {
  const parsed = FailurePatternSchema.parse(VALID_FAILURE_PATTERN);
  assert.equal(parsed.status, "open");
  assert.equal(parsed.occurrence_count, 3);
});

test("FailurePatternSchema: 反例 — type 另造同义词（违反统一归因词汇）", () => {
  const result = FailurePatternSchema.safeParse({
    ...VALID_FAILURE_PATTERN,
    type: "ctx_err",
  });
  assert.equal(result.success, false);
});

test("FailurePatternSchema: 反例 — status 非 open/resolved、occurrence_count < 1", () => {
  assert.equal(
    FailurePatternSchema.safeParse({
      ...VALID_FAILURE_PATTERN,
      status: "closed",
    }).success,
    false,
  );
  assert.equal(
    FailurePatternSchema.safeParse({
      ...VALID_FAILURE_PATTERN,
      occurrence_count: 0,
    }).success,
    false,
  );
});

test("ImprovementProposalSchema: 正例（02 §8.5 示例）", () => {
  const parsed = ImprovementProposalSchema.parse(VALID_PROPOSAL);
  assert.equal(parsed.status, "draft");
  assert.equal(parsed.created_by, "worker");
});

test("ImprovementProposalSchema: 7 种提案类型全部合法", () => {
  for (const type of [
    "loop_spec_proposal",
    "runtime_adapter_proposal",
    "memory_packet_template_proposal",
    "verification_rule_proposal",
    "policy_profile_proposal",
    "eval_task_proposal",
    "skill_or_instruction_proposal",
  ]) {
    assert.equal(
      ImprovementProposalSchema.safeParse({ ...VALID_PROPOSAL, type }).success,
      true,
      `type ${type} should be valid`,
    );
  }
});

test("ImprovementProposalSchema: 发布管线 7 状态全部合法", () => {
  for (const status of [
    "draft",
    "shadow",
    "canary",
    "approved",
    "published",
    "rolled_back",
    "rejected",
  ]) {
    assert.equal(
      ImprovementProposalSchema.safeParse({ ...VALID_PROPOSAL, status })
        .success,
      true,
      `status ${status} should be valid`,
    );
  }
});

test("ImprovementProposalSchema: 反例 — 未知类型 / 未知状态 / 未知来源", () => {
  assert.equal(
    ImprovementProposalSchema.safeParse({
      ...VALID_PROPOSAL,
      type: "config_proposal",
    }).success,
    false,
  );
  assert.equal(
    ImprovementProposalSchema.safeParse({
      ...VALID_PROPOSAL,
      status: "regression", // regression 是管线档位，不是持久化状态
    }).success,
    false,
  );
  assert.equal(
    ImprovementProposalSchema.safeParse({
      ...VALID_PROPOSAL,
      created_by: "robot",
    }).success,
    false,
  );
});

test("ProposalPipelineStageSchema: 四档（shadow/regression/canary/publish）", () => {
  for (const stage of ["shadow", "regression", "canary", "publish"]) {
    assert.equal(ProposalPipelineStageSchema.safeParse(stage).success, true);
  }
  assert.equal(ProposalPipelineStageSchema.safeParse("draft").success, false);
});
