import assert from "node:assert/strict";
import test from "node:test";
import { DecisionEntrySchema, RunDecisionRequestSchema } from "./decision.js";
import { IntentContractSchema } from "./intent-contract.js";
import { LoopCardSchema } from "./loop-card.js";
import { RunLedgerEntrySchema } from "./run-ledger.js";
import {
  JudgmentReportSchema,
  VerificationInputBundleSchema,
  VerifierReportSchema,
} from "./verification.js";

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
  security_level: "workspace_write",
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

test("LoopCard: max_retries >= max_turns 合法 (先触者停语义)", () => {
  // loop-card.ts: 无严格小于约束 —— 先触者停语义下 max_retries >= max_turns
  // 合法 (retry 预算与轮次预算各自独立触顶, 谁先耗尽谁生效)。
  const valid = structuredClone(loopCardExample);
  valid.loop.stop_rules.max_retries = 10;
  assert.equal(LoopCardSchema.safeParse(valid).success, true);
});

test("IntentContract: 非法 source 枚举值应失败", () => {
  const invalid = structuredClone(intentContractExample);
  invalid.source = "carrier_pigeon";
  assert.equal(IntentContractSchema.safeParse(invalid).success, false);
});

test("IntentContract: max_retries >= max_turns 合法 (06 #31 先触者停)", () => {
  // budget.ts: max_retries 与 max_turns 同时生效、先触者停, 无严格小于
  // 约束 (spec 未规定, 06 偏差 #31 移除了实现私加的约束)。
  const valid = structuredClone(intentContractExample);
  valid.budget.max_retries = 3;
  assert.equal(IntentContractSchema.safeParse(valid).success, true);
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

// 示例照抄 docs/spec/02-schema契约.md §5 / §6
const verificationInputBundleExample = {
  intent_ref: "intent://123",
  task_type: "code_change",
  success_criteria: ["tests pass", "no public API change"],
  workspace_ref: "workspace://goal_xxx-2",
  exit_status: 0,
  evidence_refs: {
    diff: "artifact://diff.patch",
    test_output: "artifact://test.log",
    stdout: "artifact://stdout.log",
    stderr: "artifact://stderr.log",
    structured_output: "artifact://codex-output.jsonl",
    executor_summary: "artifact://executor-summary.md",
  },
  runtime_event_refs: ["artifact://runtime-events.jsonl"],
  permission_event_refs: ["artifact://permission-events.jsonl"],
  test_output_refs: ["artifact://test.log"],
  artifact_refs: ["artifact://screenshot.png"],
  policy_intent_ref: "policy://assisted_local",
  known_failure_patterns: ["flaky_test_order_dependence"],
  verifier_chain: ["static", "runtime", "review"],
};

const verifierReportExample = {
  verifier_phase: "runtime",
  status: "failed",
  evidence_refs: ["artifact://test-output.log"],
  unresolved_risks: ["auth 集成测试 2 例失败"],
  recommendation: "retry",
  confidence: 0.87,
  requires_human: false,
};

const judgmentReportExample = {
  overall: "failed",
  next_action: "retry",
  retryable: true,
  requires_human: false,
  evidence: ["artifact://test-output.log", "artifact://lint.log"],
  unresolved_risks: ["auth 集成测试 2 例失败"],
};

test("VerificationInputBundle: spec 示例 parse 通过", () => {
  const result = VerificationInputBundleSchema.safeParse(
    verificationInputBundleExample,
  );
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
});

test("VerifierReport: spec 示例 parse 通过", () => {
  const result = VerifierReportSchema.safeParse(verifierReportExample);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
});

test("JudgmentReport: spec 示例 parse 通过", () => {
  const result = JudgmentReportSchema.safeParse(judgmentReportExample);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
});

test("VerifierReport: requires_human 缺省默认 false", () => {
  const { requires_human: _omitted, ...withoutDefault } = structuredClone(
    verifierReportExample,
  );
  const result = VerifierReportSchema.safeParse(withoutDefault);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  assert.equal(result.data?.requires_human, false);
});

test("VerifierReport: confidence 超出 0–1 应失败", () => {
  const invalid = structuredClone(verifierReportExample);
  invalid.confidence = 1.5;
  assert.equal(VerifierReportSchema.safeParse(invalid).success, false);
});

test("LoopCard: 旧卡（无 verification.commands）向后兼容 parse 通过", () => {
  const result = LoopCardSchema.safeParse(loopCardExample);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  assert.equal(result.data?.loop.verification.commands, undefined);
});

test("LoopCard: 阶段 1 扩展 verification.commands parse 通过", () => {
  const extended = structuredClone(loopCardExample);
  extended.loop.verification = {
    required: ["static", "runtime"],
    commands: {
      static: ["pnpm run lint"],
      runtime: ["pnpm run test -- --smoke"],
    },
  } as typeof extended.loop.verification;
  const result = LoopCardSchema.safeParse(extended);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  assert.deepEqual(result.data?.loop.verification.commands, {
    static: ["pnpm run lint"],
    runtime: ["pnpm run test -- --smoke"],
  });
});

// --- P0: layered-verifier 掛載點擴展 ---

test("LoopCard: P0 扩展 rule/structural phase parse 通过", () => {
  const extended = structuredClone(loopCardExample);
  extended.loop.verification = {
    required: ["static", "runtime", "rule", "structural", "review"],
  };
  const result = LoopCardSchema.safeParse(extended);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  assert.deepEqual(result.data?.loop.verification.required, [
    "static",
    "runtime",
    "rule",
    "structural",
    "review",
  ]);
});

test("LoopCard: P2 verification.rules 內嵌規則 parse 通过", () => {
  const extended = structuredClone(loopCardExample);
  extended.loop.verification = {
    required: ["rule"],
    rules: [
      {
        name: "no-hardcoded-secrets",
        pattern: "secret",
        severity: "error",
        message: "檢測到疑似硬編碼密鑰",
        suggestion: "改用環境變數",
        scope: "changed",
        files: [".ts"],
      },
    ],
  } as typeof extended.loop.verification;
  const result = LoopCardSchema.safeParse(extended);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  assert.equal(result.data?.loop.verification.rules?.[0]?.scope, "changed");
});

test("LoopCard: P2 verification.rules 缺省 severity/scope 有預設值", () => {
  const extended = structuredClone(loopCardExample);
  extended.loop.verification = {
    required: ["rule"],
    rules: [{ name: "r", pattern: "x", message: "m" }],
  } as typeof extended.loop.verification;
  const result = LoopCardSchema.safeParse(extended);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  assert.equal(result.data?.loop.verification.rules?.[0]?.severity, "error");
  assert.equal(result.data?.loop.verification.rules?.[0]?.scope, "changed");
});

test("LoopCard: P2 verification.rules 非法 scope 應失敗", () => {
  const extended = structuredClone(loopCardExample);
  extended.loop.verification = {
    required: ["rule"],
    rules: [{ name: "r", pattern: "x", message: "m", scope: "everywhere" }],
  } as typeof extended.loop.verification;
  assert.equal(LoopCardSchema.safeParse(extended).success, false);
});

test("LoopCard: interaction verifier config parse 通过", () => {
  const extended = structuredClone(loopCardExample);
  extended.loop.verification = {
    required: ["static", "interaction"],
    interaction: {
      enabled: true,
      url: "http://localhost:3400",
      start_command: "pnpm dev",
      ready_url: "http://localhost:3400/health",
      timeout_ms: 180000,
      install_command: "pnpm add -D @playwright/test playwright",
    },
  } as typeof extended.loop.verification;
  const result = LoopCardSchema.safeParse(extended);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  assert.equal(result.data?.loop.verification.interaction?.enabled, true);
  assert.equal(
    result.data?.loop.verification.interaction?.install_command,
    "pnpm add -D @playwright/test playwright",
  );
});

test("VerifierReport: P0 扩展字段 score/issues/auto_fixable/suggested_fix parse 通过", () => {
  const extended = {
    ...verifierReportExample,
    score: 0.65,
    issues: [
      {
        id: "L2-001",
        severity: "critical",
        layer: "rule",
        location: { file: "src/config.ts", line: 15 },
        message: "检测到硬编码密钥",
        suggestion: "使用 process.env.API_KEY",
        auto_fixable: true,
        fix: "const API_KEY = process.env.API_KEY;",
      },
    ],
    auto_fixable: true,
    suggested_fix: "移除硬编码密钥并补 .env.example",
  };
  const result = VerifierReportSchema.safeParse(extended);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  assert.equal(result.data?.issues?.[0]?.severity, "critical");
});

test("VerifierReport: score 超出 0–1 应失败", () => {
  const invalid = { ...verifierReportExample, score: 1.5 };
  assert.equal(VerifierReportSchema.safeParse(invalid).success, false);
});

test("VerifierReport: issues 内 layer 使用新 phase 枚举", () => {
  const withIssue = {
    ...verifierReportExample,
    issues: [{ id: "X", severity: "minor", layer: "structural", message: "m" }],
  };
  const result = VerifierReportSchema.safeParse(withIssue);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
});

test("IntentContract: P0 扩展 intent_understanding parse 通过", () => {
  const extended = structuredClone(intentContractExample) as Record<
    string,
    unknown
  >;
  extended.intent_understanding = {
    original_prompt: "帮我优化订单计算",
    understanding_summary: "用户希望定位并优化 calculate_total 性能",
    assumptions: ["不改动公共 API"],
    clarification_questions: [],
    generated_by: "agent",
    agent_model: "claude-opus-4-6",
    confirmed_by_human: true,
  };
  const result = IntentContractSchema.safeParse(extended);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  assert.equal(result.data?.intent_understanding?.generated_by, "agent");
});

test("IntentContract: 无 intent_understanding 的旧合约向后兼容", () => {
  const result = IntentContractSchema.safeParse(intentContractExample);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  assert.equal(result.data?.intent_understanding, undefined);
});

// 示例照抄 docs/spec/02-schema契约.md §8.2（created_at 为扩展字段，
// override 示例取自 03-API契约.md 的人工 override 审计要求）
const decisionEntryExample = {
  decision_id: "decision_001",
  loop_id: "loop_ci_fix",
  run_id: "run_20260720_001",
  decision: "needs_human",
  reason: "verifier 与 runtime 自述冲突，且涉及 protected branch",
  evidence_refs: ["artifact://diff.patch", "artifact://verifier-report.json"],
  policy_refs: ["policy://production_guarded"],
  next_action: "wait_for_approval",
  created_at: "2026-07-20T10:00:00Z",
};

test("DecisionEntry: 02 §8.2 示例 parse 通过", () => {
  const result = DecisionEntrySchema.safeParse(decisionEntryExample);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  assert.equal(result.data?.override, undefined);
});

test("DecisionEntry: 人工 override（original_judgment_ref + 理由 + feedback）parse 通过", () => {
  const withOverride = {
    ...decisionEntryExample,
    decision_id: "decision_002",
    decision: "complete",
    reason: "human approved the run, overriding the judgment",
    feedback: "人工确认风险可接受",
    override: {
      original_judgment_ref: "artifact://judgment-report.json",
      reason: "human approved the run, overriding the judgment",
      feedback: "人工确认风险可接受",
    },
  };
  const result = DecisionEntrySchema.safeParse(withOverride);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  assert.equal(
    result.data?.override?.original_judgment_ref,
    "artifact://judgment-report.json",
  );
});

test("DecisionEntry: 8 值决策枚举之外取值应失败", () => {
  const invalid = { ...decisionEntryExample, decision: "approve" };
  assert.equal(DecisionEntrySchema.safeParse(invalid).success, false);
});

test("DecisionEntry: 缺 reason / evidence_refs 非数组应失败", () => {
  const { reason: _omitted, ...withoutReason } = decisionEntryExample;
  assert.equal(DecisionEntrySchema.safeParse(withoutReason).success, false);
  const badEvidence = { ...decisionEntryExample, evidence_refs: "not-array" };
  assert.equal(DecisionEntrySchema.safeParse(badEvidence).success, false);
});

test("DecisionEntry: override 缺 original_judgment_ref 应失败", () => {
  const badOverride = {
    ...decisionEntryExample,
    override: { reason: "强判通过" },
  };
  assert.equal(DecisionEntrySchema.safeParse(badOverride).success, false);
});

test("RunDecisionRequest: 03 端点请求体正反例", () => {
  assert.equal(
    RunDecisionRequestSchema.safeParse({ decision: "approve" }).success,
    true,
  );
  assert.equal(
    RunDecisionRequestSchema.safeParse({
      decision: "request_changes",
      feedback: "先修 lint",
    }).success,
    true,
  );
  assert.equal(
    RunDecisionRequestSchema.safeParse({ decision: "merge" }).success,
    false,
  );
  assert.equal(RunDecisionRequestSchema.safeParse({}).success, false);
});
