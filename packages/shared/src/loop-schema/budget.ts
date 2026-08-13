import { z } from "zod";

/**
 * Budget — 控制平面跟踪的四类预算及其逐轮消耗快照。
 * 权威定义：docs/spec/02-schema契约.md §2（budget 是 IntentContract 的必填块、
 * 预算数值的唯一权威来源）与 loop-engineering/control-plane/预算与停止规则.md
 * （turn / retry 计量语义与 used_* 字段）。
 *
 * 计量语义（预算与停止规则.md "turn 与 retry 的关系"，权威定义）：
 * - `max_turns` 是总轮次上限，**含首轮**；`used_turns` 是已完成的轮次。
 * - `max_retries` 是 retry 次数上限，**不含首轮**；`used_retries` 是已发起
 *   的 retry 次数。两者同时生效，先触达者停（先触者停意味着 max_retries
 *   >= max_turns 也合法：轮次上限会先触达；spec 未规定严格小于关系，
 *   06 偏差 #31 —— 实现曾私加 max_retries < max_turns 约束，已按
 *   "不允许悄悄引入第三种说法"移除）。
 * - `max_tokens` 为 0 表示"不跟踪"（LoopCard 没有 token 预算来源时由
 *   contract 层写 0），不参与停止判定。
 * - used_* 缺省为 0：合约只携带 max_*（数值权威来源），used_* 由
 *   control-plane 在 run 全程累计并快照进 run_state。
 */
const BudgetObjectSchema = z.object({
  max_tokens: z.number(),
  max_time_minutes: z.number(),
  // 总轮次上限，含首轮
  max_turns: z.number(),
  // retry 次数上限，不含首轮；与 max_turns 同时生效、先触者停
  max_retries: z.number(),
  used_tokens: z.number().default(0),
  used_time_minutes: z.number().default(0),
  used_turns: z.number().default(0),
  used_retries: z.number().default(0),
  /**
   * True when the latest accumulated turn had no adapter token usage and
   * `used_tokens` is therefore not a real measurement. This is honest
   * telemetry: unavailable is distinct from zero consumption.
   */
  token_usage_unavailable: z.boolean().optional(),
});

export const BudgetSchema = BudgetObjectSchema;
export type Budget = z.infer<typeof BudgetSchema>;

/**
 * 预算上限（合约 / LoopCard 一侧的权威数值），不含 used_* 计数。
 * control-plane 每轮从合约拿到上限、在 run_state 快照上累计消耗。
 * max_retries 与 max_turns 同时生效、先触者停（无严格小于约束，06 #31）。
 */
export const BudgetLimitsSchema = BudgetObjectSchema.pick({
  max_tokens: true,
  max_time_minutes: true,
  max_turns: true,
  max_retries: true,
});
export type BudgetLimits = z.infer<typeof BudgetLimitsSchema>;
