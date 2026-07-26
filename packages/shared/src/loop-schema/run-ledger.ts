import { z } from "zod";

/**
 * run 状态机 7 态枚举（02-schema契约.md §7），run_ledger_entry.final_status
 * 复用同一枚举。
 */
export const RunStateSchema = z.enum([
  "active",
  "complete",
  "retry",
  "paused",
  "needs_human",
  "failed",
  "budget_limited",
]);
export type RunState = z.infer<typeof RunStateSchema>;

/**
 * 全库统一的失败归因词汇（02-schema契约.md §8.3 failure_pattern.type，
 * learning_event.failure_tags、known_failure_patterns 等处引用同一枚举，
 * 不得另造同义词）。
 */
export const FailureTagSchema = z.enum([
  "intent_error",
  "runtime_blackbox_error",
  "context_error",
  "memory_packet_error",
  "tool_error",
  "policy_error",
  "verification_error",
  "eval_regression",
]);
export type FailureTag = z.infer<typeof FailureTagSchema>;

/**
 * run_ledger_entry — 运行账本条目，记录一次 run 真实发生了什么；
 * 保存引用而非大文件，每次 retry 产生独立 entry。
 * 权威定义：docs/spec/02-schema契约.md §8.1。
 */
export const RunLedgerEntrySchema = z.object({
  loop_id: z.string(),
  run_id: z.string(),
  /** 触发来源 (扩展字段, 06 偏差 #28; 旧条目缺省按 "cron" 读取) */
  source: z.enum(["cron", "manual"]).optional(),
  runtime: z.object({
    adapter: z.string(),
    session_ref: z.string(),
    mode: z.string(),
    adapter_capability_snapshot: z.string(),
  }),
  input_refs: z.object({
    intent: z.string(),
    memory_packet: z.string().nullable(),
    workspace: z.string(),
  }),
  verification_refs: z.object({
    verification_input: z.string(),
    verifier_runtime: z.string(),
    verifier_report: z.string(),
    judgment_report: z.string(),
  }),
  learning_refs: z.object({
    control_decision: z.string(),
    human_feedback: z.array(z.string()),
    external_feedback: z.array(z.string()),
  }),
  artifact_refs: z.array(z.string()),
  final_status: RunStateSchema,
  created_at: z.string().datetime(),
});
export type RunLedgerEntry = z.infer<typeof RunLedgerEntrySchema>;
