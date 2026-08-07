/**
 * Phase-2 control decision (spec: docs/spec/05-分阶段计划.md 阶段 2,
 * 02-schema契约.md §6/§7, loop-engineering/control-plane/状态机.md).
 *
 * Input: the aggregated judgment_report plus run context (execution result,
 * budget headroom). Output: which state the run moves to from `active`.
 *
 * Phase-2 decision table (state machine slice: retry / budget_limited are
 * decided here; policy_blocked / bypass_used arrive with policy projection):
 *
 * | execution | verification / judgment                          | decision       |
 * |-----------|--------------------------------------------------|----------------|
 * | failed    | (any)                                            | failed         |
 * | ok        | not run (card requires no phases)                | complete       |
 * | ok        | overall == passed && !requires_human             | complete       |
 * | ok        | passed && 还有后续 subtask (planner run)         | subtask_advance |
 * | ok        | requires_human (any overall)                     | needs_human    |
 * | ok        | overall == failed && retryable && budget 有余量  | retry          |
 * | ok        | overall == failed && retryable && budget 耗尽    | budget_limited |
 * | ok        | failed && !retryable / inconclusive / escalate   | needs_human    |
 *
 * subtask_advance 一行不经 decideControl (ControlDecisionKind 是 run state
 * 词汇, 推進不是状态): run-service 在推进轮短路 (shouldAdvanceSubtask →
 * 跳过 applyJudgment), 由 control-plane.advanceSubtaskTurn 落诚实决策
 * 条目。推进守卫: requires_human / policyEscalations 非空时不推进, 回落
 * 本表 (人工透传最高优先, 02 §6)。
 *
 * Rules behind the table:
 * - requires_human is never overridden by a passing verdict (02 §6 aggregation
 *   rule: 人工透传优先级最高).
 * - retry only when the judgment says retryable AND the run's budget still
 *   has headroom for another turn (max_turns 含首轮、max_retries 不含首轮,
 *   先触者停 — 预算与停止规则.md). A retryable failure with an exhausted
 *   budget is budget_limited (状态机.md: active --预算耗尽--> budget_limited),
 *   not needs_human: there is a well-defined automatic path, just no budget.
 * - failed && !retryable / inconclusive judgments escalate to needs_human —
 *   no automatic path exists, a human decides whether the run stands.
 */

import type { JudgmentReport } from "@yep-anywhere/shared";

/** The states the phase-2 control decision can produce (from `active`). */
export type ControlDecisionKind =
  | "complete"
  | "retry"
  | "needs_human"
  | "failed"
  | "budget_limited";

export interface ControlDecisionContext {
  /** Whether the run's execution turn succeeded (executor exit ok). */
  executionOk: boolean;
  /** Whether the verification layer actually ran for this run. */
  verificationRan: boolean;
  /** Aggregated judgment_report; null when verification did not run. */
  judgment: JudgmentReport | null;
  /**
   * Whether the run's budget allows another turn (turn / retry / token /
   * time all have headroom). Computed by the control-plane from the run's
   * accumulated budget snapshot before deciding; false turns a retryable
   * failure into budget_limited instead of retry.
   */
  canRetry: boolean;
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
        "execution failed; a crashed turn is an unrecoverable error (02 §7: active → failed)",
    };
  }

  if (!ctx.verificationRan || !ctx.judgment) {
    return {
      kind: "complete",
      reason: "card requires no verification phases; execution succeeded",
    };
  }

  const judgment = ctx.judgment;
  if (judgment.requires_human) {
    return {
      kind: "needs_human",
      reason: `a verifier requires human review (overall == ${judgment.overall}); human escalation outranks the verdict (02 §6)`,
    };
  }

  if (judgment.overall === "passed") {
    return {
      kind: "complete",
      reason: "judgment overall == passed",
    };
  }

  if (judgment.overall === "failed" && judgment.retryable) {
    if (ctx.canRetry) {
      return {
        kind: "retry",
        reason:
          "judgment overall == failed and retryable; budget has headroom for another turn (状态机.md: active → retry)",
      };
    }
    return {
      kind: "budget_limited",
      reason:
        "judgment overall == failed and retryable, but the run's budget is exhausted (状态机.md: active --预算耗尽--> budget_limited; max_turns / max_retries 先触者停)",
    };
  }

  return {
    kind: "needs_human",
    reason: `judgment overall == ${judgment.overall}, not automatically retryable (next_action: ${judgment.next_action}); escalating to needs_human`,
  };
}
