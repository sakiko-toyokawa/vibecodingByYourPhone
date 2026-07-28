/**
 * 策略档案解析：LoopCard 的 policy 开关 → 完整 PolicyProfile。
 *
 * card.loop.policy 只携带选择项（profile 名 / approval_mode，见
 * loop-schema/loop-card.ts 的 Yep-extension 注释）；risk_rules /
 * hard_gates / bypass 允许范围由本注册表补全，保证分类与裁决规则集中
 * 一处、可测试。
 *
 * 命名档注册表（修复"policy_profile 覆盖只换标签不换规则"）：
 * policy_profile_proposal 的档名覆盖在这里解析出**不同的真实规则**
 * —— published 一个 strict 档会让后续 run 的 medium 动作从自批准变成
 * 升级人工。档名不在注册表时回落风险模型.md 推荐默认值（旧卡兼容，
 * 与阶段 2 行为一致）。
 *
 * card 级增量：card.loop.human_gate.required_for（02 §1 "必须人工闸门的
 * 情形"）在解析时并入 hard_gates——card 声明"这些情形必须人工闸门"，与
 * 硬闸门同路径升级 needs_human。
 *
 * 返回 null 表示 card 未声明 policy —— run 保持阶段 0/1 的只读 plan
 * 行为（策略投影不参与，交互式与既有 loop 行为零变化）。
 */

import type {
  HardGateAction,
  LoopCard,
  PolicyProfile,
} from "@yep-anywhere/shared";

/** 硬闸门七项（权威清单：风险模型.md；引用，不另造）。 */
export const ALL_HARD_GATES: HardGateAction[] = [
  "merge",
  "deploy",
  "delete",
  "publish",
  "bill",
  "notify",
  "close",
];

/** 风险模型.md 的推荐 risk_rules 默认值。 */
const DEFAULT_RISK_RULES: PolicyProfile["risk_rules"] = {
  low: "auto",
  medium: "auto_if_in_workspace",
  high: "review_or_policy",
  critical: "human_required",
};

/** 命名档的规则差异（未列出的维度回落默认值）。 */
export interface ProfileDefinition {
  risk_rules?: Partial<PolicyProfile["risk_rules"]>;
  hard_gates?: HardGateAction[];
  bypass_scope?: PolicyProfile["bypass_scope"];
}

/**
 * 命名档注册表。档名的语义即其规则集合（新增档时在这里登记，不得在
 * 调用处特判）。
 *
 * - `loop_bypass` / `github_issue_local_fix`：默认全量（本地、可回滚、
 *   可审计的自批准）；
 * - `loop_strict_review`：严格审查档——medium 动作也要升级人工
 *   （review_or_policy），本地命令不在 bypass 自批准范围内；适合高
 *   风险仓库的无人值守 run。
 */
export const NAMED_PROFILES: Record<string, ProfileDefinition> = {
  loop_bypass: {},
  github_issue_local_fix: {},
  workspace_local_fix: {},
  loop_strict_review: {
    risk_rules: {
      medium: "review_or_policy",
      high: "human_required",
    },
    bypass_scope: {
      allow_workspace_write: true,
      allow_local_commands: false,
    },
  },
};

/**
 * Resolve the card's policy block into a full PolicyProfile.
 * Returns null when the card declares no policy (legacy read-only runs).
 *
 * nameOverride: policy_profile_proposal 的档名覆盖（装配层在 published /
 * canary 生效时传入）——覆盖不只换标签，规则按覆盖档名从注册表解析。
 */
export function resolvePolicyProfile(
  card: LoopCard,
  nameOverride?: string,
): PolicyProfile | null {
  const policy = card.loop.policy;
  if (!policy?.approval_mode) {
    return null;
  }
  const name = nameOverride ?? policy.profile ?? `loop_${policy.approval_mode}`;
  const definition = NAMED_PROFILES[name] ?? {};
  const baseGates = definition.hard_gates
    ? [...definition.hard_gates]
    : [...ALL_HARD_GATES];
  // card 级 human_gate.required_for 并入硬闸门（求并集、去重）——card 声明
  // "这些情形必须人工闸门"，与硬闸门同路径升级 needs_human。required_for
  // 词汇与硬闸门动作词同空间（merge/deploy/delete/publish/bill/notify/
  // close）；未识别的词原样保留——裁决器按字符串匹配（arbiter.ts 的
  // hard_gates.includes），不匹配即不生效、不报错。
  const requiredFor = card.loop.human_gate?.required_for ?? [];
  const hardGates = [
    ...new Set<string>([...baseGates, ...requiredFor]),
  ] as HardGateAction[];
  return {
    policy_profile: name,
    approval_mode: policy.approval_mode,
    risk_rules: { ...DEFAULT_RISK_RULES, ...definition.risk_rules },
    hard_gates: hardGates,
    // 人工闸门与Bypass.md "Bypass 下允许的东西"：本地、可回滚、可审计。
    bypass_scope: definition.bypass_scope ?? {
      allow_workspace_write: true,
      allow_local_commands: true,
    },
  };
}
