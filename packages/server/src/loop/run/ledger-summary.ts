/**
 * Ledger summary projection builder.
 *
 * Extracted from run-service.ts during Phase-3 refactoring.
 */

import type { JudgmentReport, RunLedgerEntry } from "@yep-anywhere/shared";
import type { ControlPlane } from "../control-plane/control-plane.js";
import type { RunLedgerStore } from "../state/run-ledger-store.js";
import type { LedgerSummary } from "./types.js";

export interface BuildLedgerSummaryDeps {
  runLedgerStore: RunLedgerStore;
  controlPlane?: ControlPlane;
}

/** Build the 03 LedgerSummary projection from the ledger file + artifacts. */
export async function buildLedgerSummary(
  deps: BuildLedgerSummaryDeps,
  runId: string,
  loopId: string,
  entry: RunLedgerEntry | null,
  /** 首轮在飞时 run_state 尚未落账, 用执行上下文合约的预算上限兜底 */
  fallbackBudget?: { max_turns: number; max_retries: number } | null,
): Promise<LedgerSummary> {
  const refs = entry?.verification_refs;
  const notApplicable = (ref: string | undefined): ref is string =>
    ref !== undefined && ref !== "not_applicable";

  let judgmentSummary: LedgerSummary["judgment_summary"] = null;
  // 判定文件名随轮次走 (judgment-report[-turnN].json): 已完成 run 以
  // 账本 verification_refs 的引用为准, 在飞 run 回退首轮名。
  const judgmentName = notApplicable(refs?.judgment_report)
    ? (refs?.judgment_report ?? "").slice(
        (refs?.judgment_report ?? "").lastIndexOf("/") + 1,
      )
    : "judgment-report.json";
  const judgmentJson = await deps.runLedgerStore.readArtifact(
    runId,
    judgmentName,
  );
  if (judgmentJson) {
    try {
      const judgment = JSON.parse(judgmentJson) as JudgmentReport;
      judgmentSummary = {
        overall: judgment.overall,
        next_action: judgment.next_action,
        requires_human: judgment.requires_human,
      };
    } catch {
      console.warn(
        `[LoopRunService] judgment-report.json for run ${runId} is unparseable`,
      );
    }
  }

  const decisionEntries = await deps.runLedgerStore.readDecisionEntries(runId);
  const latestBlockingDecision = [...decisionEntries]
    .reverse()
    .find((decision) => decision.blocker_fingerprint);
  const artifactRefs = entry?.artifact_refs ?? [];
  const collectorReportRef =
    [...artifactRefs]
      .reverse()
      .find((ref) => /\/collector-report(?:-turn\d+)?\.json$/.test(ref)) ??
    null;
  const handoffRef =
    [...artifactRefs]
      .reverse()
      .find((ref) => /\/machine-state\.json$/.test(ref)) ??
    [...artifactRefs]
      .reverse()
      .find((ref) => /\/turn-handoff(?:-turn\d+)?\.json$/.test(ref)) ??
    null;

  // turns_used / retries_used come from the control-plane's budget snapshot
  // (03: budget 消耗对照 max_turns / max_retries); the run_state belongs to
  // this run only when its run_id matches (same-loop runs are serial but a
  // newer run may already hold the loop's state file). max_* 同源 — 前端
  // 按 used / max 展示, 无快照时为 null (显示 "—") 。
  let turnsUsed = 1;
  let retriesUsed = 0;
  let maxTurns: number | null = null;
  let maxRetries: number | null = null;
  const runState = await deps.controlPlane?.getRunState(loopId);
  if (runState && runState.run_id === runId && runState.budget) {
    turnsUsed = runState.budget.used_turns;
    retriesUsed = runState.budget.used_retries;
    maxTurns = runState.budget.max_turns;
    maxRetries = runState.budget.max_retries;
  } else if (fallbackBudget) {
    maxTurns = fallbackBudget.max_turns;
    maxRetries = fallbackBudget.max_retries;
  }
  const lastDecisionEntry = decisionEntries[decisionEntries.length - 1];

  return {
    turns_used: turnsUsed,
    retries_used: retriesUsed,
    max_turns: maxTurns,
    max_retries: maxRetries,
    last_decision: lastDecisionEntry
      ? {
          decision: lastDecisionEntry.decision,
          reason: lastDecisionEntry.reason,
        }
      : null,
    verifier_report_refs: notApplicable(refs?.verifier_report)
      ? [refs.verifier_report]
      : [],
    judgment_report_ref: notApplicable(refs?.judgment_report)
      ? refs.judgment_report
      : null,
    collector_report_ref: collectorReportRef,
    handoff_ref: handoffRef,
    blocker_fingerprint: latestBlockingDecision?.blocker_fingerprint ?? null,
    repeated_blocker_count: latestBlockingDecision?.repeated_blocker_count ?? 0,
    judgment_summary: judgmentSummary,
    decision_refs:
      decisionEntries.length > 0 ? [`ledger://decision-${runId}`] : [],
    // Failure attribution recorded on decision entries (adapter hard
    // errors, 02 §4). The final summary reflects the terminal decision,
    // not every historical retry: a run that eventually completes must not
    // carry old verification_error tags from earlier attempts.
    failure_tags: [...new Set(lastDecisionEntry?.failure_tags ?? [])],
  };
}
