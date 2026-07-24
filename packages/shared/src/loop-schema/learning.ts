import { z } from "zod";
import { DecisionKindSchema } from "./decision.js";
import { FailureTagSchema } from "./run-ledger.js";

/**
 * 学习侧 schema（阶段 3）——learning_event / failure_pattern /
 * improvement_proposal / 发布管线档位。
 * 权威定义：docs/spec/02-schema契约.md §8.3 / §8.4 / §8.5。
 *
 * 相对 02 的扩展（偏差已在实现报告中记录）：
 * - LearningEventSchema.loop_id：02 §8.4 只列 run_id；worker 侧聚合失败
 *   模式时需要 loop 维度（failure_pattern.affected_loop_specs），主链路
 *   发射点（control-plane）本来就知道 loop_id，补上免 worker 反查。
 * - FailurePatternSchema 增加 signature / occurrence_count / first_seen_at /
 *   last_seen_at：失败模式账本.md 的条目语义是"单次失败不进模式层，反复
 *   出现才进"，聚类指纹与出现次数/首末次时间是模式层的固有属性，02 §8.3
 *   表格未列出。
 * - ImprovementProposalSchema.created_by：02 §8.5 未列出，但阶段 3 验收 4
 *   （元规则仅人工发起）与提案验证与发布.md 要求区分 worker / human 来源。
 * - ImprovementProposalSchema.payload：02 §8.5 未列出。管线推进到
 *   canary/published 后装配层要消费提案内容（memory packet 模板 /
 *   adapter policy / policy profile 覆盖与 canary 生效范围），02 的
 *   summary 是自然语言描述，无法机器消费，补结构载荷字段（可选，
 *   无 payload 的提案只进账本不影响装配）。
 */

/**
 * learning_event — run 完成后主链路发出的轻量异步学习触发信号
 * （02 §8.4）。不是改进提案，也不能直接发布规则；主链路发出后即继续，
 * 不等学习结果（只发不等）。存储：learning/events.jsonl 每行一条
 * （04-存储约定.md），主链路追加写、learning worker 只读消费。
 */
export const LearningEventSchema = z.object({
  /** 事件标识（幂等键） */
  event_id: z.string(),
  /** 来源 run */
  run_id: z.string(),
  /** 来源 loop（扩展字段，见文件头注释） */
  loop_id: z.string(),
  /** 本轮控制决策（同 decision_entry.decision 枚举） */
  decision: DecisionKindSchema,
  /** judgment_report 引用（artifact://）；无 judgment 时填 "not_available" */
  judgment_ref: z.string(),
  /** 相关账本条目（ledger://） */
  ledger_refs: z.array(z.string()),
  /** 明显失败标签（failure_pattern.type 的 8 值归因词汇）；无则空数组 */
  failure_tags: z.array(FailureTagSchema),
  /** 发出时间 */
  created_at: z.string().datetime(),
});
export type LearningEvent = z.infer<typeof LearningEventSchema>;

/** failure_pattern 状态（02 §8.3） */
export const FailurePatternStatusSchema = z.enum(["open", "resolved"]);
export type FailurePatternStatus = z.infer<typeof FailurePatternStatusSchema>;

/**
 * failure_pattern — 失败模式账本条目（02 §8.3），只由 learning worker 写
 * （04-存储约定.md 单写者表）。type 复用全库统一的 8 值失败归因词汇
 * （FailureTagSchema，不得另造同义词）。
 *
 * 条目语义（失败模式账本.md）：单次失败不进模式层，反复出现才进——
 * signature 是 worker 聚类的指纹，occurrence_count / first_seen_at /
 * last_seen_at 记录出现次数与时间范围。
 */
export const FailurePatternSchema = z.object({
  /** 模式标识 */
  pattern_id: z.string(),
  /** 失败归因（8 值权威词汇，同 learning_event.failure_tags 元素） */
  type: FailureTagSchema,
  /** 模式描述 */
  summary: z.string(),
  /** 聚类签名/指纹（worker 按归因类别 + 证据特征生成，扩展字段） */
  signature: z.string(),
  /** 出现次数（扩展字段；>1 才值得进模式层） */
  occurrence_count: z.number().int().min(1),
  /** 首次出现时间（扩展字段） */
  first_seen_at: z.string().datetime(),
  /** 最近一次出现时间（扩展字段） */
  last_seen_at: z.string().datetime(),
  /** 证据 run id 列表 */
  evidence_runs: z.array(z.string()),
  /** 受影响的 loop */
  affected_loop_specs: z.array(z.string()),
  /** 建议动作（如 proposal_required） */
  suggested_action: z.string(),
  /** 模式状态 */
  status: FailurePatternStatusSchema,
});
export type FailurePattern = z.infer<typeof FailurePatternSchema>;

/** 提案类型（02 §8.5，7 值） */
export const ProposalTypeSchema = z.enum([
  "loop_spec_proposal",
  "runtime_adapter_proposal",
  "memory_packet_template_proposal",
  "verification_rule_proposal",
  "policy_profile_proposal",
  "eval_task_proposal",
  "skill_or_instruction_proposal",
]);
export type ProposalType = z.infer<typeof ProposalTypeSchema>;

/**
 * 发布管线状态（02 §8.5，7 值）。没有 eval 证据的提案只能停留在
 * draft 或 shadow；推进 / 回滚的合法性由 proposal-store 的迁移表守卫。
 */
export const ProposalStatusSchema = z.enum([
  "draft",
  "shadow",
  "canary",
  "approved",
  "published",
  "rolled_back",
  "rejected",
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

/** 提案风险档（02 §8.5）；high 必须人工审查 */
export const ProposalRiskSchema = z.enum(["low", "medium", "high"]);
export type ProposalRisk = z.infer<typeof ProposalRiskSchema>;

/**
 * 发布管线档位（02 §8.5 / 05 阶段 3：shadow → regression → canary →
 * publish 四档推进）。这是管线执行的阶段词汇，与持久化的 ProposalStatus
 * 不是同一枚举：regression 是 shadow→canary 之间的验证档，通过后才推进
 * 状态。每次档位推进 / 回滚记入提案 history（管线可审计）。
 */
export const ProposalPipelineStageSchema = z.enum([
  "shadow",
  "regression",
  "canary",
  "publish",
]);
export type ProposalPipelineStage = z.infer<typeof ProposalPipelineStageSchema>;

/** 提案来源（扩展字段，见文件头注释）：元规则变更仅 human */
export const ProposalCreatedBySchema = z.enum(["worker", "human"]);
export type ProposalCreatedBy = z.infer<typeof ProposalCreatedBySchema>;

/**
 * 提案结构载荷（扩展字段，见文件头注释）——装配层消费 published / canary
 * 提案时读取的机器可读内容。字段按提案类型取用：
 * - memory_packet_template_proposal → memory_packet_template
 * - runtime_adapter_proposal → adapter_policy
 * - policy_profile_proposal → policy_profile
 * canary_loops 与类型无关：canary 档只对这些 loop 生效（装配按 loop_id
 * 匹配）；published 后若仍携带则作为显式范围限制，缺省即全量生效。
 */
export const ProposalPayloadSchema = z.object({
  /** 注入装配 prompt 的 memory packet 模板文本 */
  memory_packet_template: z.string().optional(),
  /** adapter 调用策略覆盖键值对（如超时配置），原样带上 RuntimeInput */
  adapter_policy: z.record(z.string(), z.unknown()).optional(),
  /** 策略档名覆盖（装配解析出的 PolicyProfile.policy_profile 替换为该值） */
  policy_profile: z.string().optional(),
  /** canary 生效范围：命中的 loop id 列表 */
  canary_loops: z.array(z.string()).optional(),
});
export type ProposalPayload = z.infer<typeof ProposalPayloadSchema>;

/**
 * improvement_proposal — 改进提案（02 §8.5）。learning worker 从失败模式 /
 * 反馈 / eval 生成的"未来可能怎么改"候选项；提案不等于规则，未走完发布
 * 管线不得进正式 loop spec。存储：proposals/<proposal_id>.json
 * （04-存储约定.md），经 server 进程内 proposalStore 单例串行写。
 */
export const ImprovementProposalSchema = z.object({
  /** 提案标识 */
  proposal_id: z.string(),
  /** 提案类型（7 值） */
  type: ProposalTypeSchema,
  /** 来源 failure_pattern id；每条提案必须能追溯到具体失败证据 */
  source_patterns: z.array(z.string()),
  /** 提案内容 */
  summary: z.string(),
  /** 修改对象（如 loop_ci_fix.memory_packet_template） */
  target: z.string(),
  /** 预期改善的指标 */
  expected_effect: z.string(),
  /** 可能破坏什么；高影响提案必须人工审查 */
  risk: ProposalRiskSchema,
  /** 验证计划（shadow / canary 范围与证据要求） */
  validation_plan: z.string(),
  /** 发布管线状态（7 值） */
  status: ProposalStatusSchema,
  /** 提案来源（扩展字段）：worker 自动生成 / 人工发起（元规则仅人工） */
  created_by: ProposalCreatedBySchema,
  /** 结构载荷（扩展字段）：装配层消费的提案内容；缺省只记账不影响装配 */
  payload: ProposalPayloadSchema.optional(),
  /** 创建时间 */
  created_at: z.string().datetime(),
});
export type ImprovementProposal = z.infer<typeof ImprovementProposalSchema>;
