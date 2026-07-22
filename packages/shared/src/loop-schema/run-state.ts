import { z } from "zod";
import { BudgetSchema } from "./budget.js";
import { RunStateSchema } from "./run-ledger.js";

/**
 * run_state — control-plane 维护的单 run 状态记录，落盘为
 * state/<loop_id>.json（整文件写回，SessionMetadataService 模式，
 * 见 04-存储约定.md）。
 * 权威定义：docs/spec/02-schema契约.md §7。
 *
 * 阶段 2 起 7 态枚举全部可出现（active / complete / retry / paused /
 * needs_human / failed / budget_limited），由 control-plane 的完整状态机
 * 推进。
 *
 * 相对 02 §7 的扩展（偏差与 decision.ts 的扩展同口径记录）：
 * - `run_id`：§7 未列出，但阶段 2 的幂等键（run_id + turn + state）与
 *   服务重启后按 run 找回 budget_limited / paused 等阻塞态都需要状态
 *   文件能回答"这是哪个 run"；pending_approval.run_id 只在 needs_human
 *   时存在，不够。
 * - `budget`：四类预算的逐轮消耗快照（BudgetSchema，见 budget.ts），
 *   阶段 2 budget 强制要求快照写入 run_state；阶段 1 的状态文件没有
 *   该字段，故 nullable（兼容旧文件，缺省 null）。
 *
 * `pending_approval` 的内部形状 02 §7 只规定 "object | null"，这里定义为
 * 最小承载：request_id 对应决策账本中 needs_human 条目的
 * decision_id（即 run-decision-required 事件的 request_id），run_id 用于
 * 服务重启后按 run 找回等待中的审批。
 */
export const PendingApprovalSchema = z.object({
  request_id: z.string(),
  run_id: z.string(),
  reason: z.string(),
  entered_at: z.string().datetime(),
});
export type PendingApproval = z.infer<typeof PendingApprovalSchema>;

export const RunStateRecordSchema = z.object({
  version: z.number(),
  goal_id: z.string(),
  // 本状态所属的 run（扩展字段，见文件头注释）
  run_id: z.string().default(""),
  state: RunStateSchema,
  turn: z.number(),
  intent_version: z.number(),
  workspace_ref: z.string(),
  // 最近一份 judgment_report 引用（artifact://）
  last_judgment: z.string().nullable(),
  // 待人工审批事项；needs_human 时非空，恢复须携带人工响应
  pending_approval: PendingApprovalSchema.nullable(),
  // 四类预算的逐轮消耗快照（扩展字段，见文件头注释）；阶段 1 文件为 null
  budget: BudgetSchema.nullable().default(null),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type RunStateRecord = z.infer<typeof RunStateRecordSchema>;
