/**
 * 策略裁决器（05 阶段 2 policy projection 的裁决层）。
 *
 * 输入：一次工具调用（toolName + input）+ 策略档案（PolicyProfile）。
 * 输出：allow / deny / hard_gate（升级人工）。分类在 classify.ts；
 * 这里把分类结果按 approval_mode + risk_rules + hard_gates 投影成裁决。
 *
 * 铁律（人工闸门与Bypass.md / 风险模型.md）：
 *  - 硬闸门七项即使 bypass 也一律 hard_gate（bypass ≠ 绕过硬闸门）；
 *  - bypass 只自批准"本地、可回滚、可审计"的动作；审计由
 *    approval-hook.ts 在每次 allow 时落决策账本；
 *  - manual 模式下无人值守 run 无法等待人工：低中风险也只读兜底——
 *    只读动作放行，其余 deny（不升级，避免每个写操作都把 run 挂起）。
 */

import path from "node:path";
import type { PolicyProfile } from "@yep-anywhere/shared";
import {
  type ClassifyContext,
  type ToolCallClassification,
  classifyToolCall,
} from "./classify.js";

export type PolicyDecision = "allow" | "deny" | "hard_gate";

export interface PolicyVerdict {
  decision: PolicyDecision;
  /** 判定理由（机器可读 + 人读），进审计记录 / 拒绝消息。 */
  reason: string;
  classification: ToolCallClassification;
  /**
   * True when the verdict is a review_or_policy escalation that an
   * independent reviewer may resolve before the run escalates to a human.
   * Hard gates and human_required are never reviewable.
   */
  reviewable?: boolean;
}

/** True when a write target is inside one of the task-scoped allowlist paths. */
function isAllowedDirectWriteTarget(
  filePath: string,
  workspacePath: string | undefined,
  allowlist: string[],
): boolean {
  if (!filePath || !workspacePath || allowlist.length === 0) {
    return false;
  }
  const resolved = path.resolve(workspacePath, filePath);
  return allowlist.some((allowed) => {
    const allowedPath = path.resolve(workspacePath, allowed);
    return (
      resolved === allowedPath ||
      resolved.startsWith(`${allowedPath}${path.sep}`)
    );
  });
}

/**
 * 裁决一次工具调用。纯函数，不做 IO（审计落账在 approval-hook 层）。
 */
export function arbitrate(
  profile: PolicyProfile,
  toolName: string,
  input: unknown,
  ctx: ClassifyContext = {},
): PolicyVerdict {
  const classification = classifyToolCall(toolName, input, ctx);

  // Direct-mode task boundary: a configured allowlist is the only set of
  // files/directories that may be written. Missing targets fail closed.
  if (ctx.directWriteAllowlist) {
    const writeTargets = classification.writeTargets ?? [];
    const isWrite =
      classification.action === "write" || writeTargets.length > 0;
    if (
      isWrite &&
      !writeTargets.every((target) =>
        isAllowedDirectWriteTarget(
          target,
          ctx.workspacePath,
          ctx.directWriteAllowlist ?? [],
        ),
      )
    ) {
      return {
        decision: "hard_gate",
        reason: `direct workspace write is outside IntentContract.target.files allowlist (${classification.summary}); escalating to human review`,
        classification,
      };
    }
  }

  // 1. 硬闸门：一律升级人工，approval_mode 不影响（bypass ≠ 绕过硬闸门）。
  if (
    classification.hardGate &&
    profile.hard_gates.includes(classification.hardGate)
  ) {
    return {
      decision: "hard_gate",
      reason: `hard gate '${classification.hardGate}' hit (${classification.summary}); hard gates require human approval even under bypass (bypass ≠ 绕过硬闸门, 人工闸门与Bypass.md)`,
      classification,
    };
  }

  const rule = profile.risk_rules[classification.risk];

  // 2. manual：无人值守 run 无法等待人工确认，只读兜底（其余 deny）。
  if (profile.approval_mode === "manual") {
    if (classification.risk === "low" && rule === "auto") {
      return {
        decision: "allow",
        reason: "manual mode: read-only action (risk=low, rule=auto)",
        classification,
      };
    }
    return {
      decision: "deny",
      reason: `manual approval mode: unattended run cannot wait for human confirmation; ${classification.action} (risk=${classification.risk}) is denied — stay read-only`,
      classification,
    };
  }

  // 3. assisted / full_auto / bypass：按 risk_rules 投影。
  switch (rule) {
    case "auto":
      return {
        decision: "allow",
        reason: `risk=${classification.risk} rule=auto (${profile.approval_mode})`,
        classification,
      };
    case "auto_if_in_workspace": {
      if (!classification.locallyRollbackable) {
        return {
          decision: "hard_gate",
          reason: `risk=${classification.risk} rule=auto_if_in_workspace but the action is not a local rollbackable workspace action (${classification.summary}); escalating to human review`,
          classification,
        };
      }
      // bypass 允许范围（bypass_scope）：越出允许范围的自批准不成立。
      if (profile.approval_mode === "bypass" && profile.bypass_scope) {
        if (
          classification.action === "write" &&
          !profile.bypass_scope.allow_workspace_write
        ) {
          return {
            decision: "hard_gate",
            reason: `bypass_scope.allow_workspace_write=false; workspace write (${classification.summary}) escalates to human review`,
            classification,
          };
        }
        if (
          classification.action === "execute" &&
          classification.risk !== "low" &&
          !profile.bypass_scope.allow_local_commands
        ) {
          return {
            decision: "hard_gate",
            reason: `bypass_scope.allow_local_commands=false; local command (${classification.summary}) escalates to human review`,
            classification,
          };
        }
      }
      return {
        decision: "allow",
        reason: `risk=${classification.risk} rule=auto_if_in_workspace; local rollbackable workspace action (${profile.approval_mode})`,
        classification,
      };
    }
    case "review_or_policy":
      return {
        decision: "hard_gate",
        reason: `risk=${classification.risk} rule=${rule} (${classification.summary}); escalating to human review (人工闸门: 高风险 / critical 动作一律升级)`,
        classification,
        reviewable: true,
      };
    case "human_required":
      return {
        decision: "hard_gate",
        reason: `risk=${classification.risk} rule=${rule} (${classification.summary}); escalating to human review (人工闸门: 高风险 / critical 动作一律升级)`,
        classification,
      };
  }
}
