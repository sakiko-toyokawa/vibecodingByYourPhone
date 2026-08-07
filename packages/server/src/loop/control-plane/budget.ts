/**
 * Budget helpers for the control plane.
 *
 * Extracted from control-plane.ts during Phase-3 refactoring.
 */

import type { Budget } from "@yep-anywhere/shared";
import type {
  ApplyJudgmentInput,
  ControlPlaneDeps,
  ControlPlaneState,
} from "./types.js";

/**
 * Which budget fields are exhausted. `completedTurns` is the number of
 * finished turns (max_turns 含首轮: starting another turn requires
 * completedTurns < max_turns). max_tokens == 0 means untracked.
 */
export function exhaustedFields(
  budget: Budget,
  completedTurns: number,
): string[] {
  const exhausted: string[] = [];
  if (completedTurns >= budget.max_turns) {
    exhausted.push(`max_turns (${completedTurns}/${budget.max_turns})`);
  }
  if (budget.used_retries >= budget.max_retries) {
    exhausted.push(
      `max_retries (${budget.used_retries}/${budget.max_retries})`,
    );
  }
  if (budget.used_time_minutes >= budget.max_time_minutes) {
    exhausted.push(
      `max_time_minutes (${budget.used_time_minutes}/${budget.max_time_minutes})`,
    );
  }
  if (budget.max_tokens > 0 && budget.used_tokens >= budget.max_tokens) {
    exhausted.push(`max_tokens (${budget.used_tokens}/${budget.max_tokens})`);
  }
  return exhausted;
}

/**
 * Pre-turn budget fields (beginTurn): turns / time / tokens only — see
 * the beginTurn call-site comment for why retries are excluded here.
 */
export function exhaustedAtTurnStart(budget: Budget): string[] {
  const exhausted: string[] = [];
  if (budget.used_turns >= budget.max_turns) {
    exhausted.push(`max_turns (${budget.used_turns}/${budget.max_turns})`);
  }
  if (budget.used_time_minutes >= budget.max_time_minutes) {
    exhausted.push(
      `max_time_minutes (${budget.used_time_minutes}/${budget.max_time_minutes})`,
    );
  }
  if (budget.max_tokens > 0 && budget.used_tokens >= budget.max_tokens) {
    exhausted.push(`max_tokens (${budget.used_tokens}/${budget.max_tokens})`);
  }
  return exhausted;
}

/**
 * 03 "loop-budget-warning": budget 消耗越过 80% 阈值时广播, 一次/run/
 * 字段 (内存去重; 进程重启后同一 run 再次越界会重发一次, 可接受 —
 * 告警不是事实源, run_state 才是)。
 */
export function maybeWarnBudget(
  deps: ControlPlaneDeps,
  state: ControlPlaneState,
  input: ApplyJudgmentInput,
  budget: Budget,
): void {
  if (!deps.eventBus) {
    return;
  }
  const fields: { field: "max_turns" | "max_retries"; ratio: number }[] = [];
  if (budget.max_turns > 0) {
    fields.push({
      field: "max_turns",
      ratio: budget.used_turns / budget.max_turns,
    });
  }
  if (budget.max_retries > 0) {
    fields.push({
      field: "max_retries",
      ratio: budget.used_retries / budget.max_retries,
    });
  }
  for (const { field, ratio } of fields) {
    if (ratio < 0.8) {
      continue;
    }
    const key = `${input.runId}:${field}`;
    if (state.budgetWarned.has(key)) {
      continue;
    }
    state.budgetWarned.add(key);
    deps.eventBus.emit({
      type: "loop-budget-warning",
      loop_id: input.loopId,
      run_id: input.runId,
      turns_used: budget.used_turns,
      max_turns: budget.max_turns,
      retries_used: budget.used_retries,
      max_retries: budget.max_retries,
      near_limit: field,
      timestamp: new Date().toISOString(),
    });
  }
}
