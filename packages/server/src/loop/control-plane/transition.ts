/**
 * Single-writer state transition path for the control plane.
 *
 * Extracted from control-plane.ts during Phase-3 refactoring.
 */

import type {
  Budget,
  DecisionEntry,
  DecisionKind,
  FailureTag,
  HumanReason,
  LearningEvent,
  RunState,
  RunStateRecord,
} from "@yep-anywhere/shared";
import { emitLearningEvent, emitStateMdProjection } from "./side-effects.js";
import { assertLegalTransition } from "./state-machine.js";
import type {
  ApplyJudgmentInput,
  ControlPlaneDeps,
  ControlPlaneState,
} from "./types.js";

export interface TransitionOptions {
  loopId: string;
  runId: string;
  record: RunStateRecord;
  to: RunState;
  decision: DecisionKind;
  /** Deterministic idempotency key (run_id + turn + target/cause). */
  decisionId: string;
  reason: string;
  nextAction: string;
  evidenceRefs?: string[];
  failureTags?: FailureTag[];
  /** 涉及策略（policy://）；策略投影命中的决策携带，否则为空数组。 */
  policyRefs?: string[];
  blockerFingerprint?: string;
  repeatedBlockerCount?: number;
  feedback?: string;
  waivedPhases?: string[];
  override?: DecisionEntry["override"];
  patch?: Partial<RunStateRecord>;
  humanReasons?: HumanReason[];
}

/** Deterministic decision_id = idempotency key (run_id + turn + target/cause). */
export function controlDecisionId(
  runId: string,
  turn: number,
  to: string,
): string {
  return `decision-${runId}-t${turn}-${to}`;
}

/**
 * The single writer path for every state change: transition-table guard,
 * idempotent decision-ledger append, run_state save, in-memory indexes,
 * loop-state-changed broadcast. `record.state` is the from-state.
 */
export async function transition(
  deps: ControlPlaneDeps,
  state: ControlPlaneState,
  opts: TransitionOptions,
): Promise<{
  record: RunStateRecord;
  entry: DecisionEntry;
  idempotent: boolean;
}> {
  const { record, to, runId, loopId } = opts;
  assertLegalTransition(record.state, to, { runId, turn: record.turn });

  // Idempotent write: a repeated trigger of the same transition finds its
  // entry and does not append / re-save / re-emit.
  const entries = await deps.runLedgerStore.readDecisionEntries(runId);
  const existing = entries.find((e) => e.decision_id === opts.decisionId);
  if (existing) {
    return { record, entry: existing, idempotent: true };
  }

  const now = new Date().toISOString();
  const patch: Partial<RunStateRecord> = { ...(opts.patch ?? {}) };
  if (
    (to === "needs_human" || to === "paused" || to === "budget_limited") &&
    !patch.blocked_sla
  ) {
    patch.blocked_sla = { last_reminder_at: null };
  }
  const budget: Budget | null =
    (patch.budget as Budget | undefined) ?? record.budget;
  const entry: DecisionEntry = {
    decision_id: opts.decisionId,
    loop_id: loopId,
    run_id: runId,
    decision: opts.decision,
    reason: opts.reason,
    evidence_refs: opts.evidenceRefs ?? [],
    policy_refs: opts.policyRefs ?? [],
    next_action: opts.nextAction,
    feedback: opts.feedback,
    waived_phases: opts.waivedPhases,
    override: opts.override,
    human_reasons: opts.humanReasons,
    failure_tags: opts.failureTags,
    // 账本可见逐轮消耗：每条决策携带落账时的预算快照。
    budget: budget ?? undefined,
    blocker_fingerprint: opts.blockerFingerprint,
    repeated_blocker_count: opts.repeatedBlockerCount,
    created_at: now,
  };
  await deps.runLedgerStore.appendDecisionEntry(runId, entry);

  const from = record.state;
  const updated: RunStateRecord = {
    ...record,
    ...patch,
    state: to,
    updated_at: now,
  };
  await deps.runStateStore.save(loopId, updated);
  state.statesByRunId.set(runId, to);
  state.runIndex.set(runId, loopId);

  deps.eventBus?.emit({
    type: "loop-state-changed",
    loop_id: loopId,
    run_id: runId,
    from_state: from,
    to_state: to,
    turn: record.turn,
    reason: opts.reason,
    timestamp: now,
  });

  // 04-存储约定 .loop/STATE.md 人可读投影: 每次状态迁移后整体重写
  // 原 workspace 的 STATE.md。接线点选在这里 (transition 是所有状态
  // 迁移的唯一出口), 而不是 run-service 代笔: control-plane 本就是
  // run_state 的单写者, 投影跟着同一迁移走才能保证"单写者"语义字面
  // 上成立。fire-and-forget (只发不等), 失败只 warn (投影不是事实源)。
  emitStateMdProjection(deps, state, loopId, updated);

  // 阶段 3 learning_event (02 §8.4): a terminal decision (complete /
  // failed / budget_limited) or a decision carrying failure_tags emits one
  // learning signal for the async learning worker. Fire-and-forget (只发不等):
  // the append is not awaited and any emission failure is logged by
  // emitLearningEvent, never propagated — 主链路对学习零感知.
  if (
    to === "complete" ||
    to === "failed" ||
    to === "budget_limited" ||
    to === "discarded" ||
    (entry.failure_tags?.length ?? 0) > 0
  ) {
    const event: LearningEvent = {
      // Deterministic idempotency key derived from the decision entry;
      // an idempotent replay returns above before reaching this point.
      event_id: `learn-evt-${opts.decisionId}`,
      run_id: runId,
      loop_id: loopId,
      decision: opts.decision,
      judgment_ref: updated.last_judgment ?? "not_available",
      ledger_refs: [`ledger://${runId}`, `ledger://decision-${runId}`],
      failure_tags: entry.failure_tags ?? [],
      created_at: now,
    };
    emitLearningEvent(deps, state, event);
  }

  return { record: updated, entry, idempotent: false };
}

/**
 * 失败归因挂载 (修复计划 #21): 把本决策的归因信号映射为失败模式账本
 * 8 值词汇, 去重; 无信号返回 undefined (条目缺省空数组)。只挂有真实
 * 生产信号的类型, 不伪造 intent/context/memory_packet/eval_regression。
 */
export function attributeFailureTags(
  input: ApplyJudgmentInput,
): FailureTag[] | undefined {
  const tags = new Set<FailureTag>();
  if (input.adapterFailure) {
    tags.add(input.adapterFailure.failureTag);
  }
  if (input.policyEscalation && !input.policyEscalation.reviewable) {
    tags.add("policy_error");
  }
  for (const tag of input.verifierFailureTags ?? []) {
    tags.add(tag);
  }
  if (
    input.judgment &&
    (input.judgment.overall === "failed" ||
      input.judgment.overall === "inconclusive" ||
      input.judgment.overall === "unverified")
  ) {
    tags.add("verification_error");
  }
  return tags.size > 0 ? [...tags] : undefined;
}
