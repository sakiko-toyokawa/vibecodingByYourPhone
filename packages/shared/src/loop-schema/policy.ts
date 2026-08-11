import { z } from "zod";

/**
 * Policy schemas — 硬闸门动作、风险分级、审批模式与策略投影。
 * 权威定义：
 *  - 硬闸门动作清单：docs/loop-engineering/policy-engine/风险模型.md
 *    （本清单是全库权威定义处，其他文档一律引用，不另列）；
 *  - approval mode 与 risk_rules：同上 "Approval Mode / 策略规则" 节；
 *  - bypass 语义：docs/loop-engineering/policy-engine/人工闸门与Bypass.md
 *    （bypass = 绕过人工等待，不绕过策略、审计与硬闸门）；
 *  - policy_projection 段：docs/spec/02-schema契约.md §3（RuntimeInputBundle）。
 */

/**
 * 硬闸门动作（权威七项，风险模型.md）：命中即须人工审批，
 * 即使 bypass 模式也不得自动放开（bypass ≠ 绕过硬闸门）。
 *  - merge:   合并到受保护分支（含 force push）
 *  - deploy:  部署到生产环境
 *  - delete:  删除外部资源（含 rm -rf 类破坏性删除，宁可误报）
 *  - publish: 对外发布内容（npm publish 等）
 *  - bill:    计费类动作（含 pay：支付、退款、扣费）
 *  - notify:  一切对外沟通（邮件、短信、IM、issue 评论、webhook 等）
 *  - close:   关闭 issue / PR 等状态变更
 */
export const HardGateActionSchema = z.enum([
  "merge",
  "deploy",
  "delete",
  "publish",
  "bill",
  "notify",
  "close",
]);
export type HardGateAction = z.infer<typeof HardGateActionSchema>;

/** 风险四级（风险模型.md 默认四级）。 */
export const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

/**
 * 审批模式（风险模型.md Approval Mode）：
 *  - manual:    高介入，关键动作都需人工确认（无人值守 run 下退化为只读）
 *  - assisted:  低中风险自动，高风险升级
 *  - full_auto: 更少人工等待，但仍受策略控制
 *  - bypass:    跳过人工等待，不跳过策略（本地、可回滚、可审计才自动放开）
 */
export const ApprovalModeSchema = z.enum([
  "manual",
  "assisted",
  "full_auto",
  "bypass",
]);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

/** 单个风险等级的处置规则（风险模型.md 策略规则示例的取值集合）。 */
export const RiskRuleSchema = z.enum([
  "auto",
  "auto_if_in_workspace",
  "review_or_policy",
  "human_required",
]);
export type RiskRule = z.infer<typeof RiskRuleSchema>;

export const RiskRulesSchema = z.object({
  low: RiskRuleSchema,
  medium: RiskRuleSchema,
  high: RiskRuleSchema,
  critical: RiskRuleSchema,
});
export type RiskRules = z.infer<typeof RiskRulesSchema>;

/**
 * bypass 允许范围（人工闸门与Bypass.md "Bypass 下允许的东西"：
 * 本地、可回滚、可审计、不涉及真实不可逆外部后果）。
 */
export const BypassScopeSchema = z.object({
  // 允许自批准 workspace 内的文件写（Edit/Write 等）
  allow_workspace_write: z.boolean(),
  // 允许自批准本地可回滚命令（跑测试 / 构建 / lint / 本地 git 操作等）
  allow_local_commands: z.boolean(),
});
export type BypassScope = z.infer<typeof BypassScopeSchema>;

/**
 * PolicyProfile — 策略档案（风险模型.md 完整策略对象示例的对齐实现）。
 * 切换 profile 本身应可审计（profile 名进入每条自批准审计记录的
 * policy_refs）。
 */
export const PolicyProfileSchema = z.object({
  policy_profile: z.string(),
  approval_mode: ApprovalModeSchema,
  risk_rules: RiskRulesSchema,
  /** Direct workspaces require explicit opt-in before mutating actions. */
  allow_direct_mutations: z.boolean().optional(),
  // 本轮启用的硬闸门（七项的子集）；命中即升级人工
  hard_gates: z.array(HardGateActionSchema),
  // approval_mode == "bypass" 时的自批准允许范围；缺省视为全允许
  bypass_scope: BypassScopeSchema.optional(),
  // 【无消费者·已挂账 06 偏差 #27】02 §3 permission_bridge_ref 段未实现,
  // 该子结构既无生产者也无消费者; 实现 native_invocation 段时回填。
  permission_bridge: z
    .object({
      adapter_profile: z.string().optional(),
      requested_runtime_limits: z.array(z.string()).optional(),
      post_run_verifiers: z.array(z.string()).optional(),
    })
    .optional(),
});
export type PolicyProfile = z.infer<typeof PolicyProfileSchema>;

/**
 * PolicyProjection — 02-schema契约.md §3 RuntimeInputBundle 的
 * policy_projection 段：策略意图投影到本轮原生调用的权限面。
 */
export const PolicyProjectionSchema = z.object({
  // 策略意图引用（policy://）
  policy_intent_ref: z.string(),
  // 沙盒级别（如 workspace-write）
  sandbox: z.string(),
  // 审批 / 权限模式（如 on_request）
  approval_or_permission_mode: z.string(),
  // 工具白名单（空数组表示不额外放开）
  allowed_tools: z.array(z.string()),
  // 工具黑名单
  disallowed_tools: z.array(z.string()),
  // 本轮涉及的硬闸门投影，命中即须人工审批
  hard_gates: z.array(HardGateActionSchema),
});
export type PolicyProjection = z.infer<typeof PolicyProjectionSchema>;
