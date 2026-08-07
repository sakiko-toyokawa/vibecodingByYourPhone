import { z } from "zod";
import { TaskPlanSchema } from "./task-plan.js";

/** Security level determined by the intent contract. */
export const SecurityLevelSchema = z.enum([
  "read_only",
  "workspace_write",
  "full_access",
]);
export type SecurityLevel = z.infer<typeof SecurityLevelSchema>;

/**
 * IntentContract v1 — loop/contract 把自然语言请求转成的可验证、可终止、
 * 有边界的合约对象，是 budget 的权威输入。
 * 权威定义：docs/spec/02-schema契约.md §2（v1 不含 approval_mode / ambiguity /
 * clarification_history / 版本化字段 / handoff 块，不得预留）。
 */
const BudgetSchema = z.object({
  max_tokens: z.number(),
  max_time_minutes: z.number(),
  // 总轮次上限，含首轮
  max_turns: z.number(),
  // retry 次数上限，不含首轮；与 max_turns 同时生效、先触者停
  // (无严格小于约束 —— 先触者停语义下 max_retries >= max_turns 合法,
  // 06 偏差 #31)
  max_retries: z.number(),
});

export const IntentContractSchema = z.object({
  intent_id: z.string(),
  source: z.enum(["cli", "ui", "webhook", "cron", "resume"]),
  raw_goal: z.string(),
  task_type: z.object({
    primary: z.string(),
    confidence: z.number().min(0).max(1),
    requires_clarification: z.boolean(),
  }),
  outcome: z.string(),
  success_criteria: z.array(z.string()),
  constraints: z.array(z.string()).default([]),
  target: z
    .object({
      files: z.array(z.string()).optional(),
      symbols: z.array(z.string()).optional(),
    })
    .optional(),
  budget: BudgetSchema,
  // 非预算类停止规则；预算数值不得在此重复出现
  stop_rules: z
    .object({
      repetition: z
        .object({
          max_same_failure: z.number().optional(),
        })
        .optional(),
      safety: z
        .object({
          stop_on_policy_block: z.boolean().optional(),
        })
        .optional(),
      ambiguity: z
        .object({
          max_clarification_turns: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  /**
   * Planner Agent 生成的多轮任务分解计划。存在时 run-service 按
   * subtasks 逐轮执行；不存在时保持原有单轮行为。
   */
  plan: TaskPlanSchema.optional(),
  /**
   * 本次 run 的安全等级，由合约根据 approval_mode / policy 确定。
   * 决定执行器使用哪种权限模式（read_only / workspace_write / full_access）。
   * default("read_only")：该字段是后加的，升级前落盘的旧合约快照没有它，
   * 缺省必须为最保守档，否则旧 run 重启恢复时 parse 失败永久卡死。
   */
  security_level: SecurityLevelSchema.default("read_only"),
  /**
   * 意圖理解區塊（P0 擴展，可選；對齊 layered-verifier 計畫 Phase 5）。
   * 承載意圖理解 Agent 的中間產物：原始需求、理解摘要、假設與待澄清問題。
   * template 路徑（既有 buildIntentContract）不填此塊；agent 路徑落地前
   * 必須經人工確認（confirmed_by_human=true 方可觸發自動 run）。
   */
  intent_understanding: z
    .object({
      original_prompt: z.string(),
      understanding_summary: z.string(),
      assumptions: z.array(z.string()).default([]),
      clarification_questions: z.array(z.string()).default([]),
      generated_by: z.enum(["template", "agent"]),
      agent_model: z.string().optional(),
      confirmed_by_human: z.boolean().default(false),
    })
    .optional(),
});
export type IntentContract = z.infer<typeof IntentContractSchema>;
