/**
 * Phase-1 control decision (spec: docs/spec/05-分阶段计划.md 阶段 1
 * "最小四状态推进" + 02-schema契约.md §6/§7).
 *
 * Input: the aggregated judgment_report plus minimal run context.
 * Output: which of the phase-1 states the run moves to.
 *
 * Phase-1 decision table (no automatic retry — retry / budget_limited are
 * owned by the phase-2 state machine):
 *
 * | execution | verification / judgment                    | decision    |
 * |-----------|--------------------------------------------|-------------|
 * | failed    | (any)                                      | failed      |
 * | ok        | not run (card requires no phases)          | complete    |
 * | ok        | overall == passed && !requires_human       | complete    |
 * | ok        | overall == passed && requires_human        | needs_human |
 * | ok        | overall failed / inconclusive (any reason) | needs_human |
 *
 * requires_human is never overridden by a passing verdict (02 §6 aggregation
 * rule: 人工透传优先级最高). A failed/inconclusive judgment with a retry
 * recommendation still goes to needs_human — phase 1 has no auto retry, so
 * a human decides whether the run stands (approve/reject/request_changes).
 */

import type { JudgmentReport } from "@yep-anywhere/shared";

/** The only states the phase-1 control decision can produce. */
export type ControlDecisionKind = "complete" | "needs_human" | "failed";

export interface ControlDecisionContext {
  /** Whether the run's execution turn succeeded (executor exit ok). */
  executionOk: boolean;
  /** Whether the verification layer actually ran for this run. */
  verificationRan: boolean;
  /** Aggregated judgment_report; null when verification did not run. */
  judgment: JudgmentReport | null;
}

export interface ControlDecision {
  kind: ControlDecisionKind;
  reason: string;
}

export function decideControl(ctx: ControlDecisionContext): ControlDecision {
  if (!ctx.executionOk) {
    return {
      kind: "failed",
      reason:
        "execution failed; phase 1 treats a crashed turn as an unrecoverable error (02 §7: active → failed)",
    };
  }

  if (!ctx.verificationRan || !ctx.judgment) {
    return {
      kind: "complete",
      reason: "card requires no verification phases; execution succeeded",
    };
  }

  const judgment = ctx.judgment;
  if (judgment.overall === "passed" && !judgment.requires_human) {
    return {
      kind: "complete",
      reason: "judgment overall == passed",
    };
  }

  if (judgment.requires_human) {
    return {
      kind: "needs_human",
      reason: `a verifier requires human review (overall == ${judgment.overall}); human escalation outranks the verdict (02 §6)`,
    };
  }

  return {
    kind: "needs_human",
    reason: `judgment overall == ${judgment.overall} (next_action: ${judgment.next_action}); phase 1 has no automatic retry — escalating to needs_human`,
  };
}
