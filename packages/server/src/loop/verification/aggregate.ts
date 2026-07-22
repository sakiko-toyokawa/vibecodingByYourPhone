/**
 * verifier_report[] → judgment_report aggregator (pure function).
 *
 * Implements the aggregation pseudocode in docs/spec/02-schema契约.md §6:
 *   1. overall = worst status (failed > inconclusive > passed)
 *   2. requires_human passthrough has top priority — it is never overridden
 *      by other verifiers passing; when set, next_action = needs_human
 *   3. next_action order: needs_human → complete (all passed, no escalate)
 *      → escalate → retry (failed + policy allows + budget not exhausted)
 *      → stop
 *   4. retryable = overall != passed && policy.allowRetry && budget not
 *      exhausted
 *   5. evidence / unresolved_risks are flattened across reports
 *
 * `interaction` placeholder reports (phase-1: marked not_applicable, see
 * verify-run.ts) are NOT VerifierReports and never reach this function.
 */

import type {
  JudgmentReport,
  VerifierReport,
  VerifierStatus,
} from "@yep-anywhere/shared";

export interface AggregatePolicy {
  /** 策略是否允许自动重试（阶段 1 由 verifier 的 retry 建议推导） */
  allowRetry: boolean;
  /** 预算是否触顶（阶段 2 的 budget 强制生效前恒为 false） */
  budgetExhausted: boolean;
}

const SEVERITY: Record<VerifierStatus, number> = {
  passed: 0,
  inconclusive: 1,
  failed: 2,
};

export function aggregateVerifierReports(
  reports: VerifierReport[],
  policy: AggregatePolicy,
): JudgmentReport {
  // 1. 最差级（空链路视为 passed：没有可判的失败证据）
  let overall: VerifierStatus = "passed";
  for (const report of reports) {
    if (SEVERITY[report.status] > SEVERITY[overall]) {
      overall = report.status;
    }
  }

  // 2. 人工透传：优先级最高，不被其他 verifier 的通过结论覆盖
  const requiresHuman = reports.some((report) => report.requires_human);
  const anyEscalate = reports.some(
    (report) => report.recommendation === "escalate",
  );
  const retryAllowed = policy.allowRetry && !policy.budgetExhausted;

  let nextAction: JudgmentReport["next_action"];
  if (requiresHuman) {
    nextAction = "needs_human";
  } else if (overall === "passed" && !anyEscalate) {
    nextAction = "complete";
  } else if (anyEscalate) {
    nextAction = "escalate";
  } else if (overall === "failed" && retryAllowed) {
    nextAction = "retry";
  } else {
    nextAction = "stop";
  }

  // 3. 可重试性
  const retryable = overall !== "passed" && retryAllowed;

  return {
    overall,
    next_action: nextAction,
    retryable,
    requires_human: requiresHuman,
    evidence: reports.flatMap((report) => report.evidence_refs),
    unresolved_risks: reports.flatMap((report) => report.unresolved_risks),
  };
}
