import { z } from "zod";

/**
 * Phase 6 双轨 Handoff 的人类可读轨。
 *
 * human_report.md 的八段采用搜索到的 AU2 八段式（Codexis / Xiaohongshu
 * 版本）：背景上下文、关键决策、工具使用记录、用户意图演进、执行结果
 * 汇总、错误与解决、未解决问题、后续计划。
 */
export const HumanHandoffDecisionSchema = z.object({
  decision: z.string(),
  rationale: z.string(),
  evidence_ref: z.string().optional(),
});
export type HumanHandoffDecision = z.infer<typeof HumanHandoffDecisionSchema>;

export const HumanHandoffToolSchema = z.object({
  tool: z.string(),
  purpose: z.string(),
  result_ref: z.string().optional(),
  idempotency_key: z.string().optional(),
  expected_hash: z.string().optional(),
});
export type HumanHandoffTool = z.infer<typeof HumanHandoffToolSchema>;

export const HumanHandoffIntentSchema = z.object({
  stage: z.string(),
  intent: z.string(),
  reason: z.string().optional(),
});
export type HumanHandoffIntent = z.infer<typeof HumanHandoffIntentSchema>;

export const HumanHandoffResultSchema = z.object({
  turn: z.number().int().nonnegative(),
  status: z.string(),
  summary: z.string(),
  refs: z.array(z.string()),
});
export type HumanHandoffResult = z.infer<typeof HumanHandoffResultSchema>;

export const HumanHandoffErrorSchema = z.object({
  error: z.string(),
  solution: z.string(),
  status: z.string(),
});
export type HumanHandoffError = z.infer<typeof HumanHandoffErrorSchema>;

export const HumanHandoffQuestionSchema = z.object({
  question: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  owner: z.string().optional(),
});
export type HumanHandoffQuestion = z.infer<typeof HumanHandoffQuestionSchema>;

export const HumanHandoffActionSchema = z.object({
  action: z.string(),
  owner: z.string().optional(),
  depends_on: z.string().optional(),
});
export type HumanHandoffAction = z.infer<typeof HumanHandoffActionSchema>;

export const HumanHandoffReportSchema = z.object({
  schema_version: z.number().int().positive(),
  run_id: z.string(),
  loop_id: z.string(),
  turn: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  sections: z.object({
    background_context: z.string(),
    key_decisions: z.array(HumanHandoffDecisionSchema),
    tool_usage: z.array(HumanHandoffToolSchema),
    user_intent_evolution: z.array(HumanHandoffIntentSchema),
    execution_results: z.array(HumanHandoffResultSchema),
    errors_and_solutions: z.array(HumanHandoffErrorSchema),
    unresolved_questions: z.array(HumanHandoffQuestionSchema),
    next_plan: z.array(HumanHandoffActionSchema),
  }),
});
export type HumanHandoffReport = z.infer<typeof HumanHandoffReportSchema>;
