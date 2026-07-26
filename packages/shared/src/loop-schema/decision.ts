import { z } from "zod";
import { BudgetSchema } from "./budget.js";
import { FailureTagSchema } from "./run-ledger.js";

/**
 * decision_entry — 决策账本条目，记录 control-plane 为什么做出某个决策
 * （运行账本回答"发生了什么"，决策账本回答"为什么"）。
 * 权威定义：docs/spec/02-schema契约.md §8.2。
 *
 * 与运行账本合并存放在 runs/<run_id>.jsonl，以 type 字段区分（见
 * 04-存储约定.md）；ledger://decision-<run_id> 解析到该文件中
 * type == "decision_entry" 的行。
 *
 * 相对 02 §8.2 的扩展（偏差已在实现报告中记录）：
 * - `created_at`：02 §8.2 未列出，但其余账本条目（§8.1/§8.4/§8.5）均有
 *   写入时间，决策账本同样需要可审计的时间序；
 * - `feedback` / `override`：03-API契约.md 要求人工决策（含 bypass /
 *   override）均须可审计，02 §8.2 未给出承载字段，这里补上——人工强判
 *   通过 / 拒绝 / 要求修改时记录 original_judgment_ref 与理由 / feedback。
 * - `failure_tags`（阶段 1 adapter 统一错误码）：adapter 硬错误（02 §4
 *   七枚举）终止 run 时，把失败模式账本归因词汇写进终止该 run 的决策
 *   条目（05 阶段 1 验收 4："失败写入账本且归因词汇符合失败模式账本"）。
 *   02 §8.2 未预留该字段；learning_event.failure_tags（§8.4）属阶段 3，
 *   这里沿用同一 FailureTagSchema 枚举，不另造同义词。
 * - `decision` 枚举补 `resumed`（阶段 2）：02 §8.2 的 8 值枚举没有承载
 *   "阻塞态恢复到 active"的词汇（retry→active、needs_human→active、
 *   paused→active、budget_limited→active 都是合法转移且须落账可审计）。
 *   新增一值而非滥用 retry / bypass_used 语义。
 * - `budget`（阶段 2）：落账时 run 的预算快照，决策账本由此可见逐轮
 *   消耗（05 阶段 2 验收 2 "账本能逐轮看到 budget 消耗"）。
 * - `blocker_fingerprint` / `repeated_blocker_count`（loop handoff
 *   extension）：needs_human / retry 类阻塞的稳定归因，用于阻止人工
 *   approve 后同一 blocker 无变化地反复恢复。
 */
export const DecisionKindSchema = z.enum([
  "retry",
  "paused",
  "needs_human",
  "failed",
  "complete",
  "budget_limited",
  "policy_blocked",
  "bypass_used",
  "resumed",
]);
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

/**
 * override 语义：人工决策覆盖了 judgment_report 的机器结论时记录。
 * `original_judgment_ref` 指向被覆盖的 judgment_report（artifact://），
 * `reason` 是 override 理由，`feedback` 是人工随决策提交的反馈原文。
 */
export const DecisionOverrideSchema = z.object({
  original_judgment_ref: z.string(),
  reason: z.string(),
  feedback: z.string().optional(),
});
export type DecisionOverride = z.infer<typeof DecisionOverrideSchema>;

export const DecisionEntrySchema = z.object({
  decision_id: z.string(),
  loop_id: z.string(),
  run_id: z.string(),
  decision: DecisionKindSchema,
  // 决策理由（机器决策写判定依据，人工决策写人工结论）
  reason: z.string(),
  evidence_refs: z.array(z.string()),
  // 涉及策略（policy://）；阶段 1 无 policy projection，恒为 []
  policy_refs: z.array(z.string()),
  // 决策后的挂起动作（如 wait_for_approval）
  next_action: z.string(),
  // 人工随决策提交的反馈（POST /api/runs/:id/decision 的 feedback）
  feedback: z.string().optional(),
  // 人工强判通过 / 拒绝 / 要求修改时非空
  override: DecisionOverrideSchema.optional(),
  // adapter 硬错误（02 §4）终止 run 时的失败归因（失败模式账本词汇）
  failure_tags: z.array(FailureTagSchema).optional(),
  // 落账时 run 的预算快照（阶段 2，见文件头注释）
  budget: BudgetSchema.optional(),
  // 同一阻塞原因的稳定指纹；通常只在 needs_human 决策上出现。
  blocker_fingerprint: z.string().optional(),
  // 当前 run 内该 blocker 连续/重复出现次数；从 1 开始。
  repeated_blocker_count: z.number().int().positive().optional(),
  created_at: z.string().datetime(),
});
export type DecisionEntry = z.infer<typeof DecisionEntrySchema>;

/**
 * POST /api/runs/:id/decision 的请求体（03-API契约.md）。
 * approve / reject / request_changes / pause；request_changes 时 feedback
 * 必填（由服务端在路由层强校验，schema 层保持 optional 以区分 400 原因）。
 */
export const RunDecisionActionSchema = z.enum([
  "approve",
  "reject",
  "request_changes",
  "pause",
]);
export type RunDecisionAction = z.infer<typeof RunDecisionActionSchema>;

export const RunDecisionRequestSchema = z.object({
  decision: RunDecisionActionSchema,
  feedback: z.string().optional(),
});
export type RunDecisionRequest = z.infer<typeof RunDecisionRequestSchema>;

/**
 * PATCH /api/loops/:id 的请求体（03-API契约.md，阶段 2）：
 * pause（主动暂停，不走审批管线）/ resume（恢复信号，不携带人工响应）/
 * archive（软删除）。未知 action 由路由层映射为 400 invalid_action。
 */
export const LoopActionSchema = z.enum(["pause", "resume", "archive"]);
export type LoopAction = z.infer<typeof LoopActionSchema>;

export const LoopActionRequestSchema = z.object({
  action: LoopActionSchema,
});
export type LoopActionRequest = z.infer<typeof LoopActionRequestSchema>;
