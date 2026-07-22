import assert from "node:assert/strict";
import test from "node:test";
import { IntentContractSchema } from "./intent-contract.js";
import { LoopCardSchema } from "./loop-card.js";
import { RunLedgerEntrySchema } from "./run-ledger.js";

// 示例照抄 docs/spec/02-schema契约.md（§1 LoopCard、§2 IntentContract、§8.1 run_ledger_entry）
const loopCardExample = {
  loop: {
    id: "dependency-upgrade-nightly",
    trigger: { type: "schedule", cron: "0 2 * * *" },
    discovery: { source: "dependency_report", query: "outdated OR vulnerable" },
    handoff: { default_task_type: "dependency_update", max_items_per_run: 3 },
    workspace: { strategy: "worktree" },
    verification: { required: ["static", "runtime"] },
    eval: {
      eval_plan: "dependency-upgrade-regression",
      regression_scope: ["dependency_update"],
      baseline: "last_green_run",
      canary_rule: "canary_one_repo_before_rollout",
    },
    observability: {
      signals: ["run_status", "budget_consumption", "verification_result"],
      required_artifacts: ["diff", "test_report"],
      dashboard_tags: ["nightly", "dependency"],
      alert_triggers: ["repeated_failure", "budget_limited"],
    },
    schedule: { queue: "background", resume_rule: "resume_from_state" },
    human_gate: {
      required_for: ["production_deploy", "major_version_upgrade"],
    },
    persistence: {
      state_file: ".loop/state/dependency-upgrade-nightly/STATE.md",
    },
    stop_rules: {
      max_turns: 10,
      max_time_minutes: 30,
      max_retries: 3,
      stop_on_repeated_failure: 3,
    },
  },
};

const intentContractExample = {
  intent_id: "intent_20260706_001",
  source: "cli",
  raw_goal: "帮我看看这个函数为什么慢",
  task_type: {
    primary: "performance_investigation",
    confidence: 0.82,
    requires_clarification: false,
  },
  outcome: "定位 calculate_total 的性能瓶颈并给出优化方案",
  success_criteria: [
    "找到具体慢点",
    "给出至少一个可验证优化建议",
    "相关测试仍通过",
  ],
  constraints: ["不改公共 API", "保持现有行为一致"],
  target: {
    files: ["src/services/order.py"],
    symbols: ["calculate_total"],
  },
  budget: {
    max_tokens: 100000,
    max_time_minutes: 20,
    max_turns: 3,
    max_retries: 2,
  },
  stop_rules: {
    repetition: { max_same_failure: 2 },
    safety: { stop_on_policy_block: true },
    ambiguity: { max_clarification_turns: 2 },
  },
};

const runLedgerEntryExample = {
  loop_id: "loop_ci_fix",
  run_id: "run_20260720_001",
  runtime: {
    adapter: "codex",
    session_ref: "session://codex-session-123",
    mode: "exec",
    adapter_capability_snapshot: "adapter-capability://codex-cli-v1",
  },
  input_refs: {
    intent: "intent://123",
    memory_packet: "memory-packet://456",
    workspace: "workspace://loop_ci_fix/run_001",
  },
  verification_refs: {
    verification_input: "verification-input://789",
    verifier_runtime: "verifier-runtime://static-runtime-review",
    verifier_report: "artifact://verifier-report.json",
    judgment_report: "artifact://judgment-report.json",
  },
  learning_refs: {
    control_decision: "ledger://decision-run_20260720_001",
    human_feedback: [],
    external_feedback: [],
  },
  artifact_refs: ["artifact://diff.patch", "artifact://test-output.log"],
  final_status: "needs_human",
  created_at: "2026-07-20T10:00:00Z",
};

test("LoopCard: spec 示例 parse 通过", () => {
  const result = LoopCardSchema.safeParse(loopCardExample);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
});

test("IntentContract: spec 示例 parse 通过", () => {
  const result = IntentContractSchema.safeParse(intentContractExample);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
});

test("RunLedgerEntry: spec 示例 parse 通过", () => {
  const result = RunLedgerEntrySchema.safeParse(runLedgerEntryExample);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
});

test("LoopCard: 非法 verification 枚举值应失败", () => {
  const invalid = structuredClone(loopCardExample);
  invalid.loop.verification.required = ["bogus"];
  assert.equal(LoopCardSchema.safeParse(invalid).success, false);
});

test("LoopCard: schedule 触发缺 cron 应失败", () => {
  const invalid = structuredClone(loopCardExample);
  invalid.loop.trigger = { type: "schedule" } as typeof invalid.loop.trigger;
  assert.equal(LoopCardSchema.safeParse(invalid).success, false);
});

test("LoopCard: max_retries >= max_turns 应失败", () => {
  const invalid = structuredClone(loopCardExample);
  invalid.loop.stop_rules.max_retries = 10;
  assert.equal(LoopCardSchema.safeParse(invalid).success, false);
});

test("IntentContract: 非法 source 枚举值应失败", () => {
  const invalid = structuredClone(intentContractExample);
  invalid.source = "carrier_pigeon";
  assert.equal(IntentContractSchema.safeParse(invalid).success, false);
});

test("IntentContract: max_retries >= max_turns 应失败", () => {
  const invalid = structuredClone(intentContractExample);
  invalid.budget.max_retries = 3;
  assert.equal(IntentContractSchema.safeParse(invalid).success, false);
});

test("IntentContract: 缺必填字段 budget 应失败", () => {
  const { budget: _omitted, ...invalid } = structuredClone(
    intentContractExample,
  );
  assert.equal(IntentContractSchema.safeParse(invalid).success, false);
});

test("RunLedgerEntry: 非法 final_status 枚举值应失败", () => {
  const invalid = structuredClone(runLedgerEntryExample);
  invalid.final_status = "learning";
  assert.equal(RunLedgerEntrySchema.safeParse(invalid).success, false);
});

test("RunLedgerEntry: 缺必填字段 loop_id 应失败", () => {
  const { loop_id: _omitted, ...invalid } = structuredClone(
    runLedgerEntryExample,
  );
  assert.equal(RunLedgerEntrySchema.safeParse(invalid).success, false);
});
