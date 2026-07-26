import { z } from "zod";
import { VerificationPhaseSchema } from "./loop-card.js";

/**
 * VerificationInputBundle — verifier 的输入包，与给 executor 的
 * RuntimeInputBundle 严格区分：verifier 只拿判断所需证据，不拿 executor
 * 的完整内部 session。
 * 权威定义：docs/spec/02-schema契约.md §5。
 */
export const VerificationInputBundleSchema = z.object({
  intent_ref: z.string(),
  task_type: z.string(),
  success_criteria: z.array(z.string()),
  workspace_ref: z.string(),
  exit_status: z.number(),
  // 分类证据引用，键固定为六个；executor_summary 只能辅助理解，
  // 不能替代确定性证据
  evidence_refs: z.object({
    diff: z.string().nullable(),
    test_output: z.string().nullable(),
    stdout: z.string().nullable(),
    stderr: z.string().nullable(),
    structured_output: z.string().nullable(),
    executor_summary: z.string().nullable(),
  }),
  runtime_event_refs: z.array(z.string()),
  // 权限事件；高风险任务必须包含
  permission_event_refs: z.array(z.string()),
  test_output_refs: z.array(z.string()),
  artifact_refs: z.array(z.string()),
  policy_intent_ref: z.string(),
  // 已知失败模式 id（FailureTag 归因词汇），供 verifier 对照
  known_failure_patterns: z.array(z.string()),
  // 本轮验证链路与顺序（四段验证的有序子集）
  verifier_chain: z.array(VerificationPhaseSchema),
});
export type VerificationInputBundle = z.infer<
  typeof VerificationInputBundleSchema
>;

/**
 * verifier_report — 单个 verifier 的输出。
 * 权威定义：docs/spec/02-schema契约.md §6。
 */
export const VerifierStatusSchema = z.enum([
  "passed",
  "failed",
  "inconclusive",
]);
export type VerifierStatus = z.infer<typeof VerifierStatusSchema>;

export const VerifierRecommendationSchema = z.enum([
  "retry",
  "stop",
  "escalate",
]);
export type VerifierRecommendation = z.infer<
  typeof VerifierRecommendationSchema
>;

export const VerifierReportSchema = z.object({
  // 该报告来自四段中哪一段（枚举复用 loop-card 的 VerificationPhaseSchema）
  verifier_phase: VerificationPhaseSchema,
  status: VerifierStatusSchema,
  // 支撑结论的证据；reviewer 必须引用证据而非只给自然语言意见
  evidence_refs: z.array(z.string()),
  unresolved_risks: z.array(z.string()),
  recommendation: VerifierRecommendationSchema,
  confidence: z.number().min(0).max(1),
  // 该 verifier 是否要求人工介入
  requires_human: z.boolean().default(false),
});
export type VerifierReport = z.infer<typeof VerifierReportSchema>;

/**
 * judgment_report — 验证策略层把同一轮所有 verifier_report 聚合成的
 * 单一判断，交给 control-plane；编排层只记录与传递它，不另立字段。
 * 权威定义：docs/spec/02-schema契约.md §6（聚合规则伪代码见同节，
 * 实现于 server 侧 loop/verification/aggregate.ts）。
 */
export const JudgmentNextActionSchema = z.enum([
  "complete",
  "retry",
  "needs_human",
  "escalate",
  "stop",
]);
export type JudgmentNextAction = z.infer<typeof JudgmentNextActionSchema>;

export const JudgmentReportSchema = z.object({
  // 各 verifier_report status 的最差级：failed > inconclusive > passed
  overall: VerifierStatusSchema,
  next_action: JudgmentNextActionSchema,
  // 策略规则依据 overall / next_action 判定
  retryable: z.boolean(),
  // 任一 verifier requires_human=true 时透传为 true
  requires_human: z.boolean(),
  // 各 verifier_report evidence_refs 汇总
  evidence: z.array(z.string()),
  // 各 verifier_report unresolved_risks 汇总
  unresolved_risks: z.array(z.string()),
});
export type JudgmentReport = z.infer<typeof JudgmentReportSchema>;

export const CollectorReportSchema = z.object({
  collector_phase: z.literal("review"),
  status: VerifierStatusSchema,
  evidence_refs: z.array(z.string()),
  unresolved_risks: z.array(z.string()),
  recommendation: VerifierRecommendationSchema,
  confidence: z.number().min(0).max(1),
  requires_human: z.boolean().default(false),
  summary: z.string(),
});
export type CollectorReport = z.infer<typeof CollectorReportSchema>;

export const TurnHandoffSchema = z.object({
  run_id: z.string(),
  loop_id: z.string(),
  turn: z.number().int().positive(),
  workspace_ref: z.string(),
  session_ref: z.string().nullable(),
  judgment_ref: z.string().nullable(),
  collector_report_ref: z.string().nullable(),
  blocker_fingerprint: z.string().nullable(),
  repeated_blocker_count: z.number().int().positive().nullable(),
  evidence_refs: z.array(z.string()),
  next_required_checks: z.array(z.string()),
  actions_not_to_repeat: z.array(z.string()),
  created_at: z.string().datetime(),
});
export type TurnHandoff = z.infer<typeof TurnHandoffSchema>;
