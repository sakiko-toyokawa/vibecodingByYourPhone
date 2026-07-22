/**
 * loop 侧 canUseTool 投影钩子（05 阶段 2：canUseTool 规则来源从硬编码
 * 改为策略投影——loop 路径专用，不碰交互会话）。
 *
 * 装配：run-service 每个 turn 用本模块创建一个钩子，经
 * ModelSettings.toolApprovalHook → Process 注入；Process.handleToolApproval
 * 在显式 deny/allow 规则之后、permissionMode 四档逻辑之前先问钩子
 * （钩子缺席 = 交互会话，行为零变化）。
 *
 * 裁决映射：
 *  - allow:     自批准，并落一条 bypass_used 决策账本（工具名、关键参数、
 *               判定理由——05 阶段 2 "每一次自批准都写决策账本"）。
 *               审计写失败时 fail-closed（拒绝该调用）：bypass 的核心承诺
 *               是"可审计"，无法落账的自批准不成立。
 *  - deny:      拒绝（manual 模式的只读兜底），不落账。
 *  - hard_gate: 拒绝该工具调用 + 记录升级（escalations），并落一条
 *               policy_blocked 决策账本；turn 结束后 run-service 把 run
 *               升级 needs_human（bypass 下硬闸门仍被拦）。
 */

import type { DecisionEntry, PolicyProfile } from "@yep-anywhere/shared";
import type { ToolApprovalResult } from "../../sdk/types.js";
import type { RunLedgerStore } from "../state/run-ledger-store.js";
import { type PolicyVerdict, arbitrate } from "./arbiter.js";

/** 一次硬闸门 / 高风险升级（run-service 在 turn 结束时装配成 needs_human）。 */
export interface PolicyEscalation {
  /** 硬闸门动作或风险动作描述（如 "merge"）。 */
  action: string;
  /** 升级理由（判定理由原文）。 */
  reason: string;
  /** 关键参数摘要。 */
  summary: string;
  /** 策略档案引用（policy://<profile>），进决策账本 policy_refs。 */
  policyRef: string;
}

export interface LoopToolApprovalHookDeps {
  profile: PolicyProfile;
  runId: string;
  loopId: string;
  turn: number;
  workspacePath?: string;
  store: RunLedgerStore;
  /** 升级收集器（按 turn 重置）；hard_gate 裁决会 push 一条。 */
  escalations: PolicyEscalation[];
}

const HARD_GATE_DENY_HINT =
  "This action is blocked by a policy hard gate and the run has been escalated for human review. Do NOT retry it; finish with a text report.";

export function createLoopToolApprovalHook(
  deps: LoopToolApprovalHookDeps,
): (toolName: string, input: unknown) => Promise<ToolApprovalResult> {
  const policyRef = `policy://${deps.profile.policy_profile}`;
  let auditSeq = 0;

  const appendAudit = async (
    verdict: PolicyVerdict,
    toolName: string,
    kind: "bypass_used" | "policy_blocked",
  ): Promise<void> => {
    auditSeq += 1;
    const entry: DecisionEntry = {
      decision_id: `decision-${deps.runId}-t${deps.turn}-${kind}-${auditSeq}`,
      loop_id: deps.loopId,
      run_id: deps.runId,
      decision: kind,
      reason: `${kind === "bypass_used" ? "bypass self-approval" : "policy hard-gate block"}: tool=${toolName} action=${verdict.classification.action} risk=${verdict.classification.risk} (${verdict.classification.summary}); ${verdict.reason}`,
      evidence_refs: [],
      policy_refs: [policyRef],
      next_action:
        kind === "policy_blocked" ? "escalated_to_needs_human" : "none",
      created_at: new Date().toISOString(),
    };
    await deps.store.appendDecisionEntry(deps.runId, entry);
  };

  return async (toolName, input) => {
    const verdict = arbitrate(deps.profile, toolName, input, {
      workspacePath: deps.workspacePath,
    });

    switch (verdict.decision) {
      case "allow":
        try {
          await appendAudit(verdict, toolName, "bypass_used");
        } catch (error) {
          // Fail-closed: bypass 的自批准以可审计为前提，审计落账失败即拒绝。
          console.error(
            `[policy] audit append failed for run ${deps.runId}; denying ${toolName} (fail-closed):`,
            error,
          );
          return {
            behavior: "deny",
            message:
              "policy audit ledger write failed; self-approval is not allowed without audit (fail-closed)",
          };
        }
        return { behavior: "allow" };

      case "hard_gate":
        deps.escalations.push({
          action:
            verdict.classification.hardGate ?? verdict.classification.action,
          reason: verdict.reason,
          summary: verdict.classification.summary,
          policyRef,
        });
        try {
          await appendAudit(verdict, toolName, "policy_blocked");
        } catch (error) {
          // 升级已记录（escalations），审计落账失败不改变拦截结论。
          console.error(
            `[policy] policy_blocked audit append failed for run ${deps.runId}:`,
            error,
          );
        }
        return {
          behavior: "deny",
          message: `${verdict.reason}. ${HARD_GATE_DENY_HINT}`,
        };

      case "deny":
        console.warn(
          `[policy] run ${deps.runId}: denied ${toolName} — ${verdict.reason}`,
        );
        return { behavior: "deny", message: verdict.reason };
    }
  };
}
