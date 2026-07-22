import { z } from "zod";
import { RunStateSchema } from "./run-ledger.js";

/**
 * run_state — control-plane 维护的单 run 状态记录，落盘为
 * state/<loop_id>.json（整文件写回，SessionMetadataService 模式，
 * 见 04-存储约定.md）。
 * 权威定义：docs/spec/02-schema契约.md §7。
 *
 * 阶段 1 只出现 active / complete / needs_human / failed / paused
 * （paused 仅经人工 pause 决策进入，恢复机制属阶段 2）；
 * retry / budget_limited 由阶段 2 的完整状态机接管。
 *
 * `pending_approval` 的内部形状 02 §7 只规定 "object | null"，这里定义为
 * 阶段 1 的最小承载：request_id 对应决策账本中 needs_human 条目的
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
  state: RunStateSchema,
  turn: z.number(),
  intent_version: z.number(),
  workspace_ref: z.string(),
  // 最近一份 judgment_report 引用（artifact://）
  last_judgment: z.string().nullable(),
  // 待人工审批事项；needs_human 时非空，恢复须携带人工响应
  pending_approval: PendingApprovalSchema.nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type RunStateRecord = z.infer<typeof RunStateRecordSchema>;
