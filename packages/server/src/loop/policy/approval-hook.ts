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

import type {
  DecisionEntry,
  IntentContract,
  PolicyProfile,
} from "@yep-anywhere/shared";
import type { ToolApprovalResult } from "../../sdk/types.js";
import type { RelationRecord } from "../relation/relation-store.js";
import type { RunLedgerStore } from "../state/run-ledger-store.js";
import { type PolicyVerdict, arbitrate } from "./arbiter.js";
import type { PolicyReviewRequest, PolicyReviewResult } from "./reviewer.js";

/** 一次硬闸门 / 高风险升级（run-service 在 turn 结束时装配成 needs_human）。 */
export interface PolicyEscalation {
  /** 硬闸门动作或风险动作描述（如 "merge"）。 */
  action: string;
  /** 升级理由（判定理由原文）。 */
  reason: string;
  /** 关键参数摘要。 */
  summary: string;
  /** True when this escalation came from a review_or_policy high-risk lane. */
  reviewable?: boolean;
  /** 策略档案引用（policy://<profile>），进决策账本 policy_refs。 */
  policyRef: string;
}

/**
 * 一次权限裁决事件（02 §5 permission_event_refs 的证据载体）：
 * 每次钩子裁决都记录一条（allow→bypass_used / hard_gate→policy_blocked /
 * deny→denied），turn 结束后由 run-service 落成 permission-events
 * artifact 并引用进 VerificationInputBundle——高风险任务的验证输入必须
 * 包含权限事件，不再是空数组。
 */
export interface PermissionEvent {
  /** 本 turn 内的事件序号（与审计决策条目同序）。 */
  seq: number;
  tool: string;
  decision: "bypass_used" | "policy_blocked" | "denied" | "review_denied";
  action: string;
  risk: string;
  /** 关键参数摘要（与审计账本同一来源）。 */
  summary: string;
  reason: string;
  policy_ref: string;
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
  /** 权限事件收集器（按 turn 重置）；每次裁决（含 allow/deny）都 push 一条。 */
  permissionEvents: PermissionEvent[];
  /** Direct-mode task-scoped write allowlist from IntentContract.target.files. */
  directWriteAllowlist?: string[];
  /** Durable external relationship context for relation-scoped actions. */
  relation?: RelationRecord | null;
  /** Intent contract used by the independent reviewer to judge intent. */
  contract?: IntentContract | null;
  /**
   * Independent read-only reviewer for review_or_policy escalations. When
   * absent, reviewable actions keep their deterministic hard_gate behavior.
   */
  policyReviewer?: (
    request: PolicyReviewRequest,
  ) => Promise<PolicyReviewResult>;
}

const HARD_GATE_DENY_HINT =
  "This action is blocked by a policy hard gate and the run has been escalated for human review. Do NOT retry it; finish with a text report.";

export function createLoopToolApprovalHook(
  deps: LoopToolApprovalHookDeps,
): (toolName: string, input: unknown) => Promise<ToolApprovalResult> {
  const policyRef = `policy://${deps.profile.policy_profile}`;
  let auditSeq = 0;
  let eventSeq = 0;

  const recordEvent = (
    verdict: PolicyVerdict,
    toolName: string,
    decision: PermissionEvent["decision"],
  ): void => {
    eventSeq += 1;
    deps.permissionEvents.push({
      seq: eventSeq,
      tool: toolName,
      decision,
      action: verdict.classification.action,
      risk: verdict.classification.risk,
      summary: verdict.classification.summary,
      reason: verdict.reason,
      policy_ref: policyRef,
    });
  };

  const appendAudit = async (
    verdict: PolicyVerdict,
    toolName: string,
    kind: "bypass_used" | "policy_blocked",
    extra?: {
      evidenceRefs?: string[];
      reasonOverride?: string;
    },
  ): Promise<void> => {
    auditSeq += 1;
    const entry: DecisionEntry = {
      decision_id: `decision-${deps.runId}-t${deps.turn}-${kind}-${auditSeq}`,
      loop_id: deps.loopId,
      run_id: deps.runId,
      decision: kind,
      reason:
        extra?.reasonOverride ??
        `${kind === "bypass_used" ? "bypass self-approval" : "policy hard-gate block"}: tool=${toolName} action=${verdict.classification.action} risk=${verdict.classification.risk} (${verdict.classification.summary}); ${verdict.reason}`,
      evidence_refs: extra?.evidenceRefs ?? [],
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
      directWriteAllowlist: deps.directWriteAllowlist,
      relation: deps.relation ?? undefined,
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
          recordEvent(verdict, toolName, "denied");
          return {
            behavior: "deny",
            message:
              "policy audit ledger write failed; self-approval is not allowed without audit (fail-closed)",
          };
        }
        recordEvent(verdict, toolName, "bypass_used");
        return { behavior: "allow" };

      case "hard_gate":
        // review_or_policy 升级先交给独立 read-only reviewer。审查 allow
        // 才自批准（仍落账）；deny 直接拒绝；hard_gate / 审查不可用才升级
        // 人工，保持 fail-closed。
        if (verdict.reviewable && deps.policyReviewer && deps.contract) {
          let review: PolicyReviewResult;
          try {
            review = await deps.policyReviewer({
              runId: deps.runId,
              loopId: deps.loopId,
              turn: deps.turn,
              toolName,
              input,
              classification: verdict.classification,
              workspacePath: deps.workspacePath ?? "",
              contract: deps.contract,
            });
          } catch (error) {
            console.error(
              `[policy] independent reviewer failed for run ${deps.runId}; treating as hard gate:`,
              error,
            );
            review = {
              decision: "hard_gate",
              reason: "independent policy reviewer failed",
              confidence: 0,
              evidenceRefs: [],
            };
          }

          if (review.decision === "allow") {
            try {
              await appendAudit(verdict, toolName, "bypass_used", {
                evidenceRefs: review.evidenceRefs,
                reasonOverride: `independent policy review approved: tool=${toolName} action=${verdict.classification.action} risk=${verdict.classification.risk} (${verdict.classification.summary}); ${review.reason}`,
              });
            } catch (error) {
              console.error(
                `[policy] audit append failed for run ${deps.runId}; denying ${toolName} after independent review (fail-closed):`,
                error,
              );
              recordEvent(verdict, toolName, "denied");
              return {
                behavior: "deny",
                message:
                  "independent policy review approved but audit ledger write failed; action denied (fail-closed)",
              };
            }
            recordEvent(verdict, toolName, "bypass_used");
            return { behavior: "allow" };
          }

          if (review.decision === "deny") {
            recordEvent(verdict, toolName, "review_denied");
            console.warn(
              `[policy] run ${deps.runId}: independent review denied ${toolName} — ${review.reason}`,
            );
            return {
              behavior: "deny",
              message: `Independent policy review denied: ${review.reason}`,
            };
          }
        }
        recordEvent(verdict, toolName, "policy_blocked");
        deps.escalations.push({
          action:
            verdict.classification.hardGate ?? verdict.classification.action,
          reason: verdict.reason,
          summary: verdict.classification.summary,
          reviewable: verdict.reviewable === true,
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
        recordEvent(verdict, toolName, "denied");
        console.warn(
          `[policy] run ${deps.runId}: denied ${toolName} — ${verdict.reason}`,
        );
        return { behavior: "deny", message: verdict.reason };
    }
  };
}
