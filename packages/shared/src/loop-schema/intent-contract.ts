import { z } from "zod";

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
});
export type IntentContract = z.infer<typeof IntentContractSchema>;
