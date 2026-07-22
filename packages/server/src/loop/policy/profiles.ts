/**
 * 策略档案解析：LoopCard 的 policy 开关 → 完整 PolicyProfile。
 *
 * card.loop.policy 只携带选择项（profile 名 / approval_mode，见
 * loop-schema/loop-card.ts 的 Yep-extension 注释）；risk_rules /
 * hard_gates / bypass 允许范围用风险模型.md 的推荐默认值在此补全，
 * 保证分类与裁决规则集中一处、可测试。
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

/**
 * Resolve the card's policy block into a full PolicyProfile.
 * Returns null when the card declares no policy (legacy read-only runs).
 */
export function resolvePolicyProfile(card: LoopCard): PolicyProfile | null {
  const policy = card.loop.policy;
  if (!policy?.approval_mode) {
    return null;
  }
  return {
    policy_profile: policy.profile ?? `loop_${policy.approval_mode}`,
    approval_mode: policy.approval_mode,
    risk_rules: { ...DEFAULT_RISK_RULES },
    hard_gates: [...ALL_HARD_GATES],
    // 人工闸门与Bypass.md "Bypass 下允许的东西"：本地、可回滚、可审计。
    bypass_scope: {
      allow_workspace_write: true,
      allow_local_commands: true,
    },
  };
}
