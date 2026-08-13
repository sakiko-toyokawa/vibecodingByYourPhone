/**
 * Phase-2 control-plane (spec: docs/spec/05-分阶段计划.md 阶段 2,
 * 03-API契约.md "POST /api/runs/:id/decision" 阶段 2 完整迁移表,
 * loop-engineering/control-plane/状态机.md + 预算与停止规则.md).
 *
 * Replaces the phase-1 minimal form with the full run state machine:
 *
 *  - Deterministic transitions: every state change goes through the
 *    transition table in state-machine.ts (authoritative: 状态机.md /
 *    02-schema契约.md §7). Illegal transitions are rejected and recorded
 *    (structured error log; the decision ledger only carries legal
 *    transitions — a rejected attempt is an interception, not a decision).
 *
 *  - Idempotent writes: every ledgered transition has a deterministic
 *    decision_id embedding run_id + turn + target state; a repeated
 *    trigger of the same transition finds the existing entry and does not
 *    append / re-save / re-emit (幂等键 run_id+turn+state).
 *
 *  - Budget enforcement: the run's Budget snapshot lives in run_state
 *    (used_turns / used_retries / used_tokens / used_time_minutes
 *    accumulated per turn; max_* from the contract, the 数值唯一权威来源).
 *    max_turns 含首轮、max_retries 不含首轮、同时生效先触者停。Every
 *    decision entry carries the budget snapshot so the ledger shows
 *    per-turn consumption. Time is also re-checked at turn start
 *    (beginTurn) — 每轮开始前检查剩余预算.
 *
 *  - needs_human bridging (as phase 1) + full human-decision table (03):
 *      approve         → active  (resume with the human response; feedback 进账本)
 *      request_changes → active  (feedback 必填, injected into the next turn)
 *      reject          → failed  (人工拒绝即终止)
 *      pause           → paused  (恢复只需信号, 不再要求人工响应)
 *    Transitions back to active fire a ResumeSignal; the run service
 *    listens and starts a fresh session for the next turn, carrying the
 *    previous state through the AU2 handoff.
 *
 *  - paused / budget_limited resume interfaces: resumePaused (恢复信号)
 *    and supplementBudget (人工补充预算) are implemented here; the HTTP
 *    control endpoints (PATCH /api/loops/:id pause/resume/archive) live in
 *    routes/loops.ts (阶段 2 第三刀). pauseActive is the active → paused
 *    side of PATCH pause (主动暂停，不走审批管线).
 *
 * control-plane is the only writer of state/<loop_id>.json (04-存储约定).
 *
 * Phase-3 refactor: the implementation has been split into focused
 * sub-modules under control-plane/; this file is a thin facade that
 * wires them together.
 */

import type {
  Budget,
  BudgetLimits,
  RunState,
  RunStateRecord,
} from "@yep-anywhere/shared";
import { BudgetSchema } from "@yep-anywhere/shared";
import { blockerFingerprint } from "./blocker.js";
import {
  exhaustedAtTurnStart,
  exhaustedFields,
  maybeWarnBudget,
} from "./budget.js";
import { findRun, findWaitingRun, runExists } from "./lookup.js";
import {
  notifyResolved,
  notifyResume,
  settleLearningEvents,
  settleStateMdProjections,
} from "./side-effects.js";
import { controlDecisionId } from "./transition.js";
import { attributeFailureTags, transition } from "./transition.js";
import type {
  ApplyJudgmentInput,
  ApplyJudgmentResult,
  BeginTurnResult,
  ControlPlaneDeps,
  ControlPlaneState,
  PauseSeed,
  ResumeSignal,
} from "./types.js";
export type {
  ApplyJudgmentInput,
  ApplyJudgmentResult,
  BeginTurnResult,
  ControlPlaneDeps,
  PauseSeed,
  ResumeSignal,
  TurnUsage,
} from "./types.js";
import { type ControlDecisionKind, decideControl } from "./decide.js";

export type ControlPlaneErrorCode =
  | "run_not_found"
  | "invalid_state"
  | "invalid_decision";

export class ControlPlaneError extends Error {
  constructor(
    readonly code: ControlPlaneErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

/** The options a needs_human run offers (03: full set). */
const DECISION_OPTIONS = [
  "approve",
  "reject",
  "request_changes",
  "pause",
  "advance_subtask",
  "waive_phases",
];

/**
 * judgment.next_action → run-decision-required 事件的 recommended 字段
 * (03-API契约 Human Gate Payload)。口径钉死:
 * - complete → "approve" (判过, 建议通过)
 * - retry → "request_changes" (建议打回修改后再试)
 * - stop → "reject" (判停, 建议终止; next_action 枚举无 failed, stop
 *   承载"失败即拒"的推荐语义)
 * - 其余 (needs_human / escalate) 或缺失 → "manual_review" (无可靠建议,
 *   前端不映射到任何按钮)
 * 硬闸门策略升级 (policyEscalation) 不走本映射 — 人工裁决场景不给默认
 * 推荐, 避免误导性建议。
 */
function recommendedDecision(nextAction: string | undefined): string {
  switch (nextAction) {
    case "complete":
      return "approve";
    case "retry":
      return "request_changes";
    case "stop":
      return "reject";
    default:
      return "manual_review";
  }
}

export class ControlPlane {
  private readonly deps: ControlPlaneDeps;
  private readonly state: ControlPlaneState;
  private resolvedListeners: ((runId: string, state: RunState) => void)[] = [];
  private resumeListeners: ((signal: ResumeSignal) => void)[] = [];

  constructor(deps: ControlPlaneDeps) {
    this.deps = deps;
    this.state = {
      pending: new Map(),
      runIndex: new Map(),
      statesByRunId: new Map(),
      pendingLearningEvents: [],
      pendingStateMdProjections: [],
      budgetWarned: new Set(),
    };
  }

  /** Latest known state for a run (undefined if never seen this process). */
  currentStateOf(runId: string): RunState | undefined {
    return this.state.statesByRunId.get(runId);
  }

  /**
   * Read the persisted run_state for a loop (state/<loop_id>.json).
   * control-plane is the only writer (04-存储约定); this is the reader for
   * the API layer (03: GET /api/runs/:id returns run_state) and the run
   * service's restart recovery.
   */
  async getRunState(loopId: string): Promise<RunStateRecord | null> {
    return this.deps.runStateStore.load(loopId);
  }

  /**
   * Called when a run reaches a terminal state from a human decision
   * (reject → failed). The run service uses it to release its in-memory
   * active-run registration. (complete/failed via applyJudgment are
   * returned synchronously to the run service, which releases directly.)
   */
  onRunResolved(listener: (runId: string, state: RunState) => void): void {
    this.resolvedListeners.push(listener);
  }

  /**
   * Called when a blocked run comes back to active (human approve /
   * request_changes, resume signal, budget supplemented). The run service
   * listens and continues the run with a new turn in a fresh session.
   */
  onResumeRequested(listener: (signal: ResumeSignal) => void): void {
    this.resumeListeners.push(listener);
  }

  /**
   * Apply a run's judgment: accumulate the turn's budget consumption,
   * decide (complete / retry / needs_human / failed / budget_limited),
   * persist run_state, append the control decision_entry (idempotently),
   * broadcast loop-state-changed, and bridge needs_human.
   */
  async applyJudgment(input: ApplyJudgmentInput): Promise<ApplyJudgmentResult> {
    this.state.runIndex.set(input.runId, input.loopId);
    const existing = await this.deps.runStateStore.load(input.loopId);

    // Idempotent replay: this turn was already judged (the run left active
    // at this turn) — return the recorded outcome without re-writing.
    if (
      existing &&
      existing.run_id === input.runId &&
      existing.turn === input.turn &&
      existing.state !== "active"
    ) {
      const entries = await this.deps.runLedgerStore.readDecisionEntries(
        input.runId,
      );
      const entry = entries.find(
        (e) =>
          e.decision_id ===
          controlDecisionId(input.runId, input.turn, existing.state),
      );
      if (entry) {
        return {
          state: existing.state as ControlDecisionKind,
          entry,
          // A PATCH-pause seeded record may carry a null budget (turn 1 had
          // no judgment yet); fall back to the contract budget with zero
          // usage — the same base the normal path below computes, never
          // fabricated consumption.
          budget: existing.budget ?? BudgetSchema.parse({ ...input.budget }),
          idempotent: true,
        };
      }
    }

    // Budget accumulation (预算与停止规则.md: max_turns 含首轮、max_retries
    // 不含首轮、同时生效先触者停). used_turns = completed turns = this turn.
    //
    // 状态文件按 loop 存储: 已有记录可能属于上一个 run (run_id 不同) ——
    // 新 run 的首次判定从 active / 合约预算重新起算; 仅当记录属于本 run
    // 时才沿用既有 from-state 与预算快照 (越序守卫 / 幂等续跑)。上个 run
    // 的 used_* 消耗不得泄漏进新 run。
    const sameRun = existing?.run_id === input.runId;
    const base: Budget =
      sameRun && existing?.budget
        ? existing.budget
        : BudgetSchema.parse({ ...input.budget });
    const budget: Budget = {
      ...base,
      used_turns: input.turn,
      used_tokens: base.used_tokens + (input.usage.tokens ?? 0),
      used_time_minutes: base.used_time_minutes + input.usage.timeMinutes,
    };
    const exhausted = exhaustedFields(budget, input.turn);
    const canRetry = exhausted.length === 0;

    const decision = decideControl({
      executionOk: input.executionOk,
      verificationRan: input.verificationRan,
      judgment: input.judgment,
      canRetry,
    });
    // 硬闸门 / 高风险策略拦截升级 needs_human（人工闸门与Bypass.md：
    // critical 动作一律升级，bypass 不例外）。终端 failed 不覆盖——
    // 轮次已崩溃，没有可审批的工作产物。
    if (input.policyEscalation && decision.kind !== "failed") {
      decision.kind = "needs_human";
      decision.reason = `policy gate '${input.policyEscalation.action}' intercepted during the turn (bypass ≠ 绕过硬闸门): ${input.policyEscalation.reason}`;
    }
    // A scheduled retry consumes retry budget immediately (不含首轮).
    if (decision.kind === "retry") {
      budget.used_retries += 1;
    }
    // 03 "loop-budget-warning": budget 消耗越过 80% 阈值时广播
    // (一次/run/字段; budget_limited 本身走 loop-state-changed 不重复)。
    maybeWarnBudget(this.deps, this.state, input, budget);

    const now = new Date().toISOString();
    const record: RunStateRecord = {
      version: 2,
      goal_id: input.goalId,
      run_id: input.runId,
      // From-state: the run is active while its turn is judged. An existing
      // record keeps its own state only when it belongs to THIS run — a
      // stale record from the loop's previous run must not re-base the new
      // run onto a terminal from-state (complete -> complete is illegal).
      state: sameRun && existing ? existing.state : "active",
      turn: input.turn,
      intent_version: sameRun && existing ? existing.intent_version : 1,
      workspace_ref: input.workspaceRef,
      last_judgment: input.judgmentRef,
      pending_approval: sameRun && existing ? existing.pending_approval : null,
      // 本轮执行的 session 引用 (06 #32; 缺省保留既有值, 重启回放兼容)
      session_ref:
        input.sessionRef ?? (sameRun && existing ? existing.session_ref : null),
      budget,
      created_at: existing?.created_at ?? input.createdAt,
      updated_at: now,
    };

    const requestId = controlDecisionId(input.runId, input.turn, decision.kind);
    const fingerprint =
      decision.kind === "needs_human"
        ? blockerFingerprint(input.judgment, input.policyEscalation)
        : undefined;
    const priorEntries = await this.deps.runLedgerStore.readDecisionEntries(
      input.runId,
    );
    const repeatedBlockerCount = fingerprint
      ? priorEntries.filter(
          (entry) =>
            entry.decision === "needs_human" &&
            entry.blocker_fingerprint === fingerprint,
        ).length + 1
      : undefined;
    // 02 §2 stop_rules.repetition.max_same_failure (card 的
    // stop_on_repeated_failure 经合约投影): 同一阻断指纹重复超过上限
    // 即停 —— needs_human 循环打断为终态 failed (预算与停止规则.md:
    // "同一 verifier 同一错误重复 → 停止或人工")。
    const maxSameFailure = input.stopRules?.repetition?.max_same_failure;
    if (
      decision.kind === "needs_human" &&
      repeatedBlockerCount !== undefined &&
      maxSameFailure !== undefined &&
      repeatedBlockerCount > maxSameFailure
    ) {
      decision.kind = "failed";
      decision.reason = `${decision.reason}; stop rule repetition.max_same_failure=${maxSameFailure} hit: the same blocker recurred ${repeatedBlockerCount} times (预算与停止规则.md: 同一错误重复即停)`;
    }

    const baseReason = input.adapterFailure
      ? `${decision.reason}; adapter hard error (${input.adapterFailure.code}): ${input.adapterFailure.message}`
      : decision.kind === "budget_limited"
        ? `${decision.reason}; exhausted: ${exhausted.join(", ")}`
        : decision.reason;
    const reason =
      repeatedBlockerCount && repeatedBlockerCount > 1
        ? `${baseReason}; repeated blocker #${repeatedBlockerCount} (${fingerprint})`
        : baseReason;

    const {
      record: updated,
      entry,
      idempotent,
    } = await transition(this.deps, this.state, {
      loopId: input.loopId,
      runId: input.runId,
      record,
      to: decision.kind,
      decision: decision.kind,
      decisionId: requestId,
      reason,
      nextAction:
        decision.kind === "needs_human" ? "wait_for_approval" : "none",
      evidenceRefs: input.judgment?.evidence ?? [],
      policyRefs: input.policyEscalation
        ? [input.policyEscalation.policyRef]
        : undefined,
      humanReasons: decision.humanReasons,
      blockerFingerprint: fingerprint,
      repeatedBlockerCount,
      // 失败归因 (失败模式账本.md 8 值词汇; 修复计划 #21: 此前只挂
      // adapter 硬错误, 验证失败/策略拦截永不可达):
      // - adapter 硬错误 → adapterFailure.failureTag (映射见 adapter-error)
      // - 硬闸门/高风险策略拦截 → policy_error
      // - verifier 判失败/判不清 (failed/inconclusive, 含验证层自身崩溃的
      //   合成 judgment) → verification_error
      // intent_error / context_error / memory_packet_error 需要 verifier
      // 侧的归因分类能力, eval_regression 由 eval 体系自身产出, 均不在
      // 此挂载 (无生产信号, 不伪造)。
      failureTags: attributeFailureTags(input),
      patch: {
        turn: input.turn,
        budget,
        last_judgment: input.judgmentRef,
        pending_approval:
          decision.kind === "needs_human"
            ? {
                request_id: requestId,
                run_id: input.runId,
                reason,
                entered_at: now,
                ...(decision.humanReasons.length > 0
                  ? { human_reasons: decision.humanReasons }
                  : {}),
                ...(input.policyEscalation?.toolCall
                  ? { tool_call: input.policyEscalation.toolCall }
                  : {}),
              }
            : null,
      },
    });

    if (!idempotent && decision.kind === "needs_human") {
      this.state.pending.set(input.runId, {
        loopId: input.loopId,
        requestId,
      });
      this.deps.eventBus?.emit({
        type: "run-decision-required",
        loop_id: input.loopId,
        run_id: input.runId,
        request_id: requestId,
        // Policy projection (阶段 2): a hard-gate escalation carries its
        // action/risk; otherwise the judgment's suggested next step.
        action:
          input.policyEscalation?.action ??
          input.judgment?.next_action ??
          "manual_review",
        risk: input.policyEscalation ? "critical" : "unrated",
        reason,
        evidence_refs: input.judgment?.evidence ?? [],
        human_reasons: decision.humanReasons,
        tool_call: input.policyEscalation?.toolCall,
        options: DECISION_OPTIONS,
        // recommended: 硬闸门升级是人工裁决场景, 不发推荐 (不给误导性
        // 默认动作, 字段缺省); 其余按 judgment.next_action 映射
        // (口径见 recommendedDecision)。
        recommended: input.policyEscalation
          ? undefined
          : recommendedDecision(input.judgment?.next_action),
        // diff_summary: run-service 捕获的工作区改动摘要, 缺失则事件
        // 不带该字段 (undefined 不进 JSON)。
        diff_summary: input.diffSummary,
        timestamp: now,
      });
    }

    return { state: decision.kind, entry, budget, idempotent };
  }

  /**
   * Begin a new turn for a run (turn >= 2). Drives the retry → active
   * transition when the run sits in retry, then runs the pre-turn budget
   * check (预算与停止规则.md 检查点: 每轮开始前检查剩余预算 — time budget is
   * re-checked here as well as at turn end). On budget exhaustion the run
   * goes active → budget_limited (先触者停) and ok=false is returned.
   */
  async beginTurn(runId: string, nextTurn: number): Promise<BeginTurnResult> {
    const found = await findRun(this.deps, this.state, runId);
    if (!found) {
      throw new ControlPlaneError("run_not_found", `Run '${runId}' not found`);
    }
    let { record } = found;
    const { loopId } = found;

    if (record.state === "retry") {
      const resumed = await transition(this.deps, this.state, {
        loopId,
        runId,
        record,
        to: "active",
        decision: "resumed",
        decisionId: `decision-${runId}-t${record.turn}-resumed-retry`,
        reason: `retry backoff elapsed; starting turn ${nextTurn} in a fresh session (retry #${record.budget?.used_retries ?? "?"})`,
        nextAction: "none",
        patch: {},
      });
      // An idempotent replay returns the pre-transition record; reload so
      // the budget check below sees the persisted active state.
      record = resumed.idempotent
        ? ((await this.deps.runStateStore.load(loopId)) ?? resumed.record)
        : resumed.record;
    }

    if (record.state !== "active") {
      throw new ControlPlaneError(
        "invalid_state",
        `Run '${runId}' cannot begin turn ${nextTurn} from state '${record.state}'`,
      );
    }

    const budget = record.budget;
    if (budget) {
      // 每轮开始前检查（预算与停止规则.md 检查点）：能否开新一轮只看
      // turns / time / tokens —— retry 预算在判定为 retry 时已消耗并授权，
      // 不在此重复闸门（否则 max_retries=1 永远走不到第一轮 retry）。
      const exhausted = exhaustedAtTurnStart(budget);
      if (exhausted.length > 0) {
        const limited = await transition(this.deps, this.state, {
          loopId,
          runId,
          record,
          to: "budget_limited",
          decision: "budget_limited",
          decisionId: controlDecisionId(runId, record.turn, "budget_limited"),
          reason: `budget exhausted before turn ${nextTurn} (每轮开始前检查, 先触者停): ${exhausted.join(", ")}`,
          nextAction: "wait_for_budget",
          patch: {},
        });
        return { ok: false, state: "budget_limited", record: limited.record };
      }
    }

    const advanced: RunStateRecord = {
      ...record,
      turn: nextTurn,
      updated_at: new Date().toISOString(),
    };
    await this.deps.runStateStore.save(loopId, advanced);
    return { ok: true, state: "active", record: advanced };
  }

  /**
   * Restart recovery gate: a run without a complete checkpoint, or whose
   * external files changed, is parked in needs_human instead of being
   * auto-resumed. The existing decision endpoint is the resume channel.
   */
  async requestRestartRecovery(
    loopId: string,
    reason: string,
  ): Promise<RunStateRecord> {
    const record = await this.deps.runStateStore.load(loopId);
    if (!record) {
      throw new ControlPlaneError(
        "run_not_found",
        `Loop '${loopId}' has no run state to recover`,
      );
    }
    if (record.state !== "active" && record.state !== "retry") {
      throw new ControlPlaneError(
        "invalid_state",
        `Run '${record.run_id}' is '${record.state}', not active/retry; restart recovery gate is not applicable`,
      );
    }
    const now = new Date().toISOString();
    const requestId = `decision-${record.run_id}-t${record.turn}-restart-recovery`;
    const recoveryReason = `restart recovery requested for ${record.state} run: ${reason}`;
    const recoveryHumanReasons = [
      {
        code: "restart_recovery",
        message:
          "Run requested confirmation after a restart; human review is required.",
      },
    ];
    const { record: updated } = await transition(this.deps, this.state, {
      loopId,
      runId: record.run_id,
      record,
      to: "needs_human",
      decision: "needs_human",
      decisionId: requestId,
      reason: recoveryReason,
      humanReasons: recoveryHumanReasons,
      nextAction: "wait_for_approval",
      evidenceRefs: [],
      patch: {
        pending_approval: {
          request_id: requestId,
          run_id: record.run_id,
          reason: recoveryReason,
          entered_at: now,
          human_reasons: recoveryHumanReasons,
        },
        session_ref: record.session_ref,
      },
    });
    this.state.pending.set(record.run_id, { loopId, requestId });
    this.deps.eventBus?.emit({
      type: "run-decision-required",
      loop_id: loopId,
      run_id: record.run_id,
      request_id: requestId,
      action: "manual_review",
      risk: "unrated",
      reason: recoveryReason,
      human_reasons: recoveryHumanReasons,
      evidence_refs: [],
      options: DECISION_OPTIONS,
      recommended: "manual_review",
      timestamp: now,
    });
    return updated;
  }

  /**
   * Advance to the next subtask turn without a terminal control decision.
   * Used by the planner-driven multi-turn loop when a subtask completes but
   * more subtasks remain. Creates or updates the run_state record so the
   * next turn can begin, while keeping the run in `active` state.
   *
   * When `advance` is provided, also appends a truthful `subtask_advance`
   * decision entry: the subtask PASSED verification, so the entry carries no
   * failure_tags and consumes no retry budget (教训: 此前由 run-service 把
   * judgment 改写成 failed/retry 借道 applyJudgment, 导致 phantom
   * verification_error 归因、retry 预算白烧、判定报告失真 —— 见
   * decision.ts 文件头 subtask_advance 条目)。推进轮的 token/time 消耗
   * 仍如实累积进预算快照。
   *
   * Turn-budget guard: advancing needs headroom for the next turn; when
   * nextTurn would exceed max_turns the run goes budget_limited instead
   * (先触者停), same as a retry with no headroom.
   */
  async advanceSubtaskTurn(
    runId: string,
    loopId: string,
    nextTurn: number,
    budget: BudgetLimits,
    sessionRef?: string | null,
    advance?: {
      /** The turn whose subtask just completed (nextTurn - 1). */
      completedTurn: number;
      /** 1-based position of the subtask that just completed. */
      subtaskIndex: number;
      subtaskCount: number;
      judgment: import("@yep-anywhere/shared").JudgmentReport | null;
      usage: { tokens: number | null; timeMinutes: number };
    },
  ): Promise<RunStateRecord> {
    this.state.runIndex.set(runId, loopId);
    const existing = await this.deps.runStateStore.load(loopId);
    const base: Budget =
      existing?.budget ??
      BudgetSchema.parse({
        ...budget,
        used_tokens: 0,
        used_time_minutes: 0,
        used_turns: 0,
        used_retries: 0,
      });
    const now = new Date().toISOString();
    // 推进轮消耗如实累积 (与 applyJudgment 的逐轮累积口径一致); retry
    // 预算不动 —— 推进不是重试。used_turns = 已完成轮次: nextTurn 尚未
    // 开始, 不能预记 (预记会让该轮未执行就被 pause 的 run 在 resume 时
    // 误判 budget_limited, UI 也会在该轮未跑时提前显示 N/N)。
    const merged: Budget = advance
      ? {
          ...base,
          used_turns: advance.completedTurn,
          used_tokens: base.used_tokens + (advance.usage.tokens ?? 0),
          used_time_minutes: base.used_time_minutes + advance.usage.timeMinutes,
        }
      : { ...base, used_turns: nextTurn };

    if (advance) {
      // 诚实的推进决策: 子任务判过, 不是失败重试 —— 无 failure_tags,
      // 不消耗 retry 预算。幂等键 = run + 完成轮 + subtask_advance。
      // 落账先于下方的轮次预算护栏: 即使护栏拦下, "子任务判过、应推进"
      // 也是事实; 重启重建按 subtask_advance 计数推导子任务索引, 护栏
      // 路径漏记会让索引回退到已完成的子任务 (重跑一遍)。
      const entry: import("@yep-anywhere/shared").DecisionEntry = {
        decision_id: controlDecisionId(
          runId,
          advance.completedTurn,
          "subtask_advance",
        ),
        loop_id: loopId,
        run_id: runId,
        decision: "subtask_advance",
        reason: `subtask ${advance.subtaskIndex}/${advance.subtaskCount} passed verification (judgment overall == passed); planner advances to subtask ${advance.subtaskIndex + 1} — multi-turn decomposition, not a failure retry (no retry budget consumed, no failure attribution)`,
        evidence_refs: advance.judgment?.evidence ?? [],
        policy_refs: [],
        next_action: "advance_subtask",
        budget: merged,
        created_at: now,
      };
      const entries = await this.deps.runLedgerStore.readDecisionEntries(runId);
      if (!entries.some((e) => e.decision_id === entry.decision_id)) {
        await this.deps.runLedgerStore.appendDecisionEntry(runId, entry);
      }
    }

    // Turn-budget guard: no headroom for the turn we are about to start →
    // budget_limited (active → budget_limited 是合法转移; max_turns 先触
    // 者停, 预算与停止规则.md)。max_retries 不在此检查 —— 推进不消费
    // retry 预算; time/token 在终局轮 applyJudgment 仍会兜底。
    if (advance && nextTurn > merged.max_turns) {
      const record: RunStateRecord = {
        version: 2,
        goal_id: existing?.goal_id ?? `intent-${runId}`,
        run_id: runId,
        state: "active",
        turn: advance.completedTurn,
        intent_version: existing?.intent_version ?? 1,
        workspace_ref:
          existing?.workspace_ref ?? `workspace://${loopId}/${runId}`,
        last_judgment: existing?.last_judgment ?? null,
        pending_approval: existing?.pending_approval ?? null,
        budget: merged,
        session_ref: sessionRef ?? existing?.session_ref ?? null,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      const { record: limited } = await transition(this.deps, this.state, {
        loopId,
        runId,
        record,
        to: "budget_limited",
        decision: "budget_limited",
        decisionId: controlDecisionId(
          runId,
          advance.completedTurn,
          "budget_limited",
        ),
        reason: `subtask ${advance.subtaskIndex}/${advance.subtaskCount} passed, but no turn budget left to start subtask ${advance.subtaskIndex + 1} (max_turns ${merged.max_turns} exhausted; 预算与停止规则.md 先触者停)`,
        nextAction: "none",
        evidenceRefs: advance.judgment?.evidence ?? [],
        patch: { turn: advance.completedTurn, budget: merged },
      });
      return limited;
    }

    const record: RunStateRecord = {
      version: 2,
      goal_id: existing?.goal_id ?? `intent-${runId}`,
      run_id: runId,
      state: "active",
      turn: nextTurn,
      intent_version: existing?.intent_version ?? 1,
      workspace_ref:
        existing?.workspace_ref ?? `workspace://${loopId}/${runId}`,
      last_judgment: existing?.last_judgment ?? null,
      pending_approval: existing?.pending_approval ?? null,
      budget: merged,
      session_ref: sessionRef ?? existing?.session_ref ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };

    await this.deps.runStateStore.save(loopId, record);
    this.state.statesByRunId.set(runId, "active");
    this.deps.eventBus?.emit({
      type: "loop-state-changed",
      loop_id: loopId,
      run_id: runId,
      from_state: existing?.state ?? "active",
      to_state: "active",
      turn: nextTurn,
      reason: `subtask advanced to turn ${nextTurn}`,
      timestamp: record.updated_at,
    });
    return record;
  }

  /**
   * Answer a needs_human run (POST /api/runs/:id/decision).
   *
   * Phase-2 transition table (03-API契约.md 完整迁移表, 状态机.md):
   *   approve          → active  (human response carried back; feedback 进账本)
   *   request_changes  → active  (feedback 必填, injected into the next turn)
   *   reject           → failed  (human rejection terminates the run)
   *   pause            → paused  (resume needs only a signal — resumePaused)
   */
  async submitDecision(
    runId: string,
    action: import("@yep-anywhere/shared").RunDecisionAction,
    feedback?: string,
    phases?: string[],
  ): Promise<RunStateRecord> {
    if (action === "request_changes" && !feedback?.trim()) {
      throw new ControlPlaneError(
        "invalid_decision",
        "feedback is required for request_changes (03: it is injected as context for the next turn)",
      );
    }

    const waiting = await findWaitingRun(this.deps, this.state, runId);
    if (!waiting) {
      if (await runExists(this.deps, this.state, runId)) {
        throw new ControlPlaneError(
          "invalid_state",
          `Run '${runId}' is not waiting for a human decision (not in needs_human)`,
        );
      }
      throw new ControlPlaneError("run_not_found", `Run '${runId}' not found`);
    }

    const { loopId, record } = waiting;
    const now = new Date().toISOString();
    if (action === "advance_subtask") {
      const updated = await transition(this.deps, this.state, {
        loopId,
        runId,
        record,
        to: "active",
        decision: "subtask_advance",
        decisionId: controlDecisionId(runId, record.turn, "subtask_advance"),
        reason:
          "human confirmed the current subtask and asked the run to advance to the next subtask",
        nextAction: "resume_next_turn",
        patch: { pending_approval: null },
      });
      this.state.pending.delete(runId);
      notifyResume(this.resumeListeners, {
        runId,
        loopId,
        cause: "human_approve",
        feedback,
        advanceSubtask: true,
      });
      return updated.record;
    }

    if (action === "waive_phases") {
      if (!phases || phases.length === 0) {
        throw new ControlPlaneError(
          "invalid_decision",
          "phases are required for waive_phases",
        );
      }
      if (!phases.every((phase) => phase === "static" || phase === "runtime")) {
        throw new ControlPlaneError(
          "invalid_decision",
          "waive_phases only supports static and runtime",
        );
      }
      const updated = await transition(this.deps, this.state, {
        loopId,
        runId,
        record,
        to: "active",
        decision: "waive_phases",
        decisionId: controlDecisionId(runId, record.turn, "waive_phases"),
        reason: `human waived verification phases: ${phases.join(", ")}`,
        nextAction: "resume_next_turn",
        feedback,
        waivedPhases: phases,
        patch: { pending_approval: null },
      });
      this.state.pending.delete(runId);
      notifyResume(this.resumeListeners, {
        runId,
        loopId,
        cause: "human_approve",
        feedback,
        waivedPhases: phases,
      });
      return updated.record;
    }

    if (action === "approve" && !feedback?.trim()) {
      const entries = await this.deps.runLedgerStore.readDecisionEntries(runId);
      const currentDecision = entries.find(
        (entry) => entry.decision_id === record.pending_approval?.request_id,
      );
      if ((currentDecision?.repeated_blocker_count ?? 0) >= 2) {
        throw new ControlPlaneError(
          "invalid_decision",
          `approve would repeat unchanged blocker ${currentDecision?.blocker_fingerprint ?? "unknown"}; use request_changes with feedback after changing the environment or instructions`,
        );
      }
    }
    const target: RunState =
      action === "reject" ? "failed" : action === "pause" ? "paused" : "active";
    const decisionKind: import("@yep-anywhere/shared").DecisionKind =
      target === "active"
        ? "resumed"
        : target === "failed"
          ? "failed"
          : "paused";

    const reasonByAction: Record<
      import("@yep-anywhere/shared").RunDecisionAction,
      string
    > = {
      approve:
        "human approved; run resumes with the human response carried back (03: needs_human → active)",
      reject: "human rejected the run",
      request_changes:
        "human requested changes; feedback is injected into the next turn's context (03: needs_human → active)",
      pause: "human paused the run from needs_human",
      advance_subtask:
        "human advanced to the next planner subtask from a needs_human gate",
      waive_phases: "human waived verification phases for the remaining run",
    };
    const restartFrom = record.pending_approval?.reason.startsWith(
      "restart recovery requested for active",
    )
      ? "active"
      : record.pending_approval?.reason.startsWith(
            "restart recovery requested for retry",
          )
        ? "retry"
        : undefined;
    const { record: updated } = await transition(this.deps, this.state, {
      loopId,
      runId,
      record,
      to: target,
      decision: decisionKind,
      decisionId: `decision-${runId}-t${record.turn}-human-${action}`,
      reason: reasonByAction[action],
      // paused resumes via a resume signal (resumePaused); active resumes
      // into the next turn via the run service's resume listener.
      nextAction:
        target === "paused"
          ? "wait_for_resume_signal"
          : target === "active"
            ? "resume_next_turn"
            : "none",
      feedback,
      // Judgment overrides (approve / reject / request_changes) record what
      // was overridden; pause is a control action, not a verdict override.
      override:
        action === "pause"
          ? undefined
          : {
              original_judgment_ref: record.last_judgment ?? "not_available",
              reason: reasonByAction[action],
              feedback,
            },
      patch: { pending_approval: null },
    });
    this.state.pending.delete(runId);

    if (target === "active") {
      notifyResume(this.resumeListeners, {
        runId,
        loopId,
        cause:
          action === "approve" && restartFrom
            ? "restart_recovery_approve"
            : action === "approve"
              ? "human_approve"
              : "human_request_changes",
        restartRecoveryFromState: restartFrom,
        feedback,
        approvedToolCall:
          action === "approve" ? record.pending_approval?.tool_call : undefined,
      });
    } else if (target === "failed") {
      notifyResolved(this.resolvedListeners, runId, target);
    }
    // paused: the run stays suspended (and registered) until resumePaused —
    // same blocking semantics as needs_human, minus the approval payload.

    return updated;
  }

  /**
   * Pause an active run (active → paused, 03 PATCH pause: 主动暂停，不走
   * 审批管线 — no approval is queued, resume needs only a signal).
   *
   * The decision_id uses the canonical run_id+turn+state form so a racing
   * applyJudgment for the same turn resolves as an idempotent replay of
   * this pause instead of an illegal transition.
   *
   * `seed` covers turn 1 still in flight (no run_state record yet): the
   * record is materialized from the run service's execution context, then
   * transitioned. Killing the executing process is the caller's job (the
   * run service terminates it right after this resolves — 阶段 2 选项 A:
   * 杀执行进程，partial result 丢弃，session_ref 保留供 audit/recovery。
   */
  async pauseActive(loopId: string, seed?: PauseSeed): Promise<RunStateRecord> {
    let record = await this.deps.runStateStore.load(loopId);
    if (!record || (seed && record.run_id !== seed.runId)) {
      if (!seed) {
        throw new ControlPlaneError(
          "run_not_found",
          `Loop '${loopId}' has no active run state to pause`,
        );
      }
      // Notional from-state: the run is active (its first turn is executing)
      // even though no judgment has landed yet.
      record = {
        version: 2,
        goal_id: seed.goalId,
        run_id: seed.runId,
        state: "active",
        turn: seed.turn,
        intent_version: 1,
        workspace_ref: seed.workspaceRef,
        last_judgment: null,
        pending_approval: null,
        // 首轮在飞被暂停: 被杀 turn 的 session 一并记录, 供 audit / 恢复
        // 参考; resume 时开 fresh session (06 #32)。
        session_ref: seed.sessionRef ?? null,
        budget: seed.budget ? BudgetSchema.parse({ ...seed.budget }) : null,
        created_at: seed.createdAt,
        updated_at: new Date().toISOString(),
      };
    }
    if (record.state !== "active") {
      throw new ControlPlaneError(
        "invalid_state",
        `Loop '${loopId}' run is '${record.state}', not active (pause requires an active run; needs_human runs are paused via POST /api/runs/:id/decision)`,
      );
    }
    const { record: updated } = await transition(this.deps, this.state, {
      loopId,
      runId: record.run_id,
      record,
      to: "paused",
      decision: "paused",
      decisionId: controlDecisionId(record.run_id, record.turn, "paused"),
      reason:
        "human paused the run via PATCH /api/loops/:id (主动暂停, 不走审批管线; the executing process is killed and the partial turn result dropped — session_ref 保留供 audit/recovery)",
      nextAction: "wait_for_resume_signal",
      patch: {},
    });
    return updated;
  }

  /**
   * Resume a paused run (paused → active, 恢复只需信号、不携带人工响应 —
   * 03 PATCH resume 语义). Wired to PATCH /api/loops/:id {action:"resume"}
   * in routes/loops.ts.
   */
  async resumePaused(loopId: string): Promise<RunStateRecord> {
    const record = await this.deps.runStateStore.load(loopId);
    if (!record) {
      throw new ControlPlaneError(
        "run_not_found",
        `Loop '${loopId}' has no run state`,
      );
    }
    if (record.state !== "paused") {
      throw new ControlPlaneError(
        "invalid_state",
        `Loop '${loopId}' run is '${record.state}', not paused (resume requires a paused run)`,
      );
    }
    const { record: updated } = await transition(this.deps, this.state, {
      loopId,
      runId: record.run_id,
      record,
      to: "active",
      decision: "resumed",
      decisionId: `decision-${record.run_id}-t${record.turn}-resumed-pause`,
      reason:
        "resume signal received; paused → active (暂停与恢复: 恢复只需信号, 不携带人工响应)",
      nextAction: "resume_next_turn",
      patch: {},
    });
    notifyResume(this.resumeListeners, {
      runId: record.run_id,
      loopId,
      cause: "resume_signal",
    });
    return updated;
  }

  /**
   * 合并闸门终局 (worktree 策略 merge gate): 人工批准合并 (needs_human →
   * active) 后, run service 执行完 git merge 调用 — active → complete
   * (合并已进原仓库) / failed (合并冲突, worktree 与分支保留供人工处理)。
   */
  async settleMerge(input: {
    loopId: string;
    runId: string;
    turn: number;
    ok: boolean;
    mergeCommitSha: string | null;
    error?: string;
  }): Promise<RunStateRecord> {
    const record = await this.deps.runStateStore.load(input.loopId);
    if (!record || record.run_id !== input.runId || record.state !== "active") {
      throw new ControlPlaneError(
        "invalid_state",
        `Loop '${input.loopId}' run is not active (settleMerge requires the post-approve active state)`,
      );
    }
    const { record: updated } = await transition(this.deps, this.state, {
      loopId: input.loopId,
      runId: input.runId,
      record,
      to: input.ok ? "complete" : "failed",
      decision: input.ok ? "complete" : "failed",
      decisionId: controlDecisionId(
        input.runId,
        input.turn,
        input.ok ? "complete" : "failed",
      ),
      reason: input.ok
        ? `merge gate approved and applied: worktree branch merged into origin (merge commit ${input.mergeCommitSha})`
        : `merge gate approved but merge failed: ${input.error ?? "unknown error"} (worktree 保留供人工处理)`,
      nextAction: "none",
      evidenceRefs: [`artifact://${input.runId}/merge-result.json`],
    });
    return updated;
  }

  /**
   * Supplement a budget_limited run's budget and resume it
   * (budget_limited → active, 状态机.md: 人工补充预算并恢复). `patch` raises
   * one or more max_* fields; the result is re-validated against
   * BudgetSchema (max_retries >= max_turns is legal — 先触者停, 06 #31).
   * Interface for the budget-resume control endpoint, which lands with the
   * routes slice.
   */
  async supplementBudget(
    loopId: string,
    patch: Partial<BudgetLimits>,
  ): Promise<RunStateRecord> {
    const record = await this.deps.runStateStore.load(loopId);
    if (!record) {
      throw new ControlPlaneError(
        "run_not_found",
        `Loop '${loopId}' has no run state`,
      );
    }
    if (record.state !== "budget_limited") {
      throw new ControlPlaneError(
        "invalid_state",
        `Loop '${loopId}' run is '${record.state}', not budget_limited`,
      );
    }
    const current = record.budget;
    if (!current) {
      throw new ControlPlaneError(
        "invalid_state",
        `Loop '${loopId}' run has no budget snapshot to supplement`,
      );
    }
    let supplemented: Budget;
    try {
      supplemented = BudgetSchema.parse({
        ...current,
        ...Object.fromEntries(
          Object.entries(patch).filter(([, value]) => value !== undefined),
        ),
      });
    } catch {
      throw new ControlPlaneError(
        "invalid_decision",
        "budget supplement is invalid (budget schema rejected the merged limits)",
      );
    }
    const { record: updated } = await transition(this.deps, this.state, {
      loopId,
      runId: record.run_id,
      record,
      to: "active",
      decision: "resumed",
      decisionId: `decision-${record.run_id}-t${record.turn}-resumed-budget`,
      reason: `budget supplemented by a human (${Object.keys(patch).join(", ")}); budget_limited → active`,
      nextAction: "resume_next_turn",
      patch: { budget: supplemented },
    });
    notifyResume(this.resumeListeners, {
      runId: record.run_id,
      loopId,
      cause: "budget_supplemented",
    });
    return updated;
  }

  /**
   * Force a non-terminal run to failed. Used by the run service when restart
   * recovery cannot rebuild the execution context or when a resumed run
   * crashes before it can be judged — preventing the run from staying stuck
   * in `active`/`retry` forever after a server restart.
   *
   * By default only transitions out of `active` or `retry`; terminal runs are
   * left untouched and other blocking states (needs_human / paused /
   * budget_limited) are preserved for human decision. Pass `{ force: true }`
   * to override this guard (used by dead-loop detection to break a recurring
   * needs_human blocker).
   */
  async failRun(
    runId: string,
    reason: string,
    opts?: { force?: boolean },
  ): Promise<RunStateRecord | null> {
    const found = await findRun(this.deps, this.state, runId);
    if (!found) {
      return null;
    }
    const { loopId, record } = found;
    if (
      record.state === "complete" ||
      record.state === "failed" ||
      record.state === "discarded" ||
      record.state === "budget_limited"
    ) {
      return record;
    }
    if (!opts?.force && record.state !== "active" && record.state !== "retry") {
      // Preserve human-facing states; do not auto-fail a run waiting for a
      // person or a resume signal / budget supplement.
      return record;
    }
    const { record: updated } = await transition(this.deps, this.state, {
      loopId,
      runId,
      record,
      to: "failed",
      decision: "failed",
      decisionId: `decision-${runId}-t${record.turn}-restart-recovery-failed`,
      reason,
      nextAction: "none",
      evidenceRefs: [],
      failureTags: ["runtime_blackbox_error"],
      patch: { pending_approval: null },
    });
    notifyResolved(this.resolvedListeners, runId, "failed");
    return updated;
  }

  /**
   * Mark a run as discarded. This is a human-initiated terminal state used
   * after rollback / worktree cleanup; the audit ledger and artifacts stay
   * intact. When the run is active/retry, `force: true` is required so the
   * caller has already terminated the executing process.
   */
  async discardRun(
    runId: string,
    reason: string,
    opts: {
      force?: boolean;
      loopId?: string;
      seed?: PauseSeed;
      evidenceRefs?: string[];
    } = {},
  ): Promise<RunStateRecord> {
    const found = await findRun(this.deps, this.state, runId);
    const loopId = found?.loopId ?? opts.loopId;
    let record = found?.record ?? null;
    if (!record && opts.seed) {
      if (!loopId) {
        throw new ControlPlaneError(
          "run_not_found",
          `Run '${runId}' has no persisted state and no loop context for discard`,
        );
      }
      record = {
        version: 2,
        goal_id: opts.seed.goalId,
        run_id: runId,
        state: "active",
        turn: opts.seed.turn,
        intent_version: 1,
        workspace_ref: opts.seed.workspaceRef,
        last_judgment: null,
        pending_approval: null,
        session_ref: opts.seed.sessionRef ?? null,
        budget: opts.seed.budget
          ? BudgetSchema.parse({ ...opts.seed.budget })
          : null,
        created_at: opts.seed.createdAt,
        updated_at: new Date().toISOString(),
      };
    }
    if (!record || !loopId) {
      throw new ControlPlaneError("run_not_found", `Run '${runId}' not found`);
    }
    if (record.state === "discarded") {
      return record;
    }
    if (
      (record.state === "active" || record.state === "retry") &&
      !opts.force
    ) {
      throw new ControlPlaneError(
        "invalid_state",
        `Run '${runId}' is '${record.state}'; discard requires force=true so the executing process can be terminated first`,
      );
    }
    const now = new Date().toISOString();
    const { record: updated } = await transition(this.deps, this.state, {
      loopId,
      runId,
      record,
      to: "discarded",
      decision: "discarded",
      decisionId: `decision-${runId}-t${record.turn}-discarded`,
      reason,
      nextAction: "none",
      evidenceRefs: opts.evidenceRefs ?? [],
      patch: { pending_approval: null },
    });
    this.state.pending.delete(runId);
    notifyResolved(this.resolvedListeners, runId, "discarded");
    return updated;
  }

  /**
   * Test hook: wait for in-flight fire-and-forget learning_event appends.
   * Production code never awaits emissions (只发不等).
   */
  async settleLearningEvents(): Promise<void> {
    await settleLearningEvents(this.state);
  }

  /**
   * Test hook: wait for in-flight fire-and-forget STATE.md projections.
   * Production code never awaits projections (只发不等).
   */
  async settleStateMdProjections(): Promise<void> {
    await settleStateMdProjections(this.state);
  }
}
