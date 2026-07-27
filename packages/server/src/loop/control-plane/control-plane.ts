/**
 * Phase-2 control-plane (spec: docs/spec/05-分阶段计划.md 阶段 2,
 * 03-API契约.md "POST /api/runs/:id/decision" 阶段 2 完整迁移表,
 * loop-engineering/control-plane/状态机.md + 预算与停止规则.md).
 *
 * Replaces the phase-1 minimal form with the full 7-state machine:
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
 *    listens and continues the run on the same session (resumeSession).
 *
 *  - paused / budget_limited resume interfaces: resumePaused (恢复信号)
 *    and supplementBudget (人工补充预算) are implemented here; the HTTP
 *    control endpoints (PATCH /api/loops/:id pause/resume/archive) live in
 *    routes/loops.ts (阶段 2 第三刀). pauseActive is the active → paused
 *    side of PATCH pause (主动暂停，不走审批管线).
 *
 * control-plane is the only writer of state/<loop_id>.json (04-存储约定).
 */

import { createHash } from "node:crypto";
import type {
  Budget,
  BudgetLimits,
  DecisionEntry,
  DecisionKind,
  FailureTag,
  IntentContract,
  JudgmentReport,
  LearningEvent,
  RunDecisionAction,
  RunState,
  RunStateRecord,
} from "@yep-anywhere/shared";
import { BudgetSchema } from "@yep-anywhere/shared";
import type { IEventBus } from "../../watcher/index.js";
import type { LearningEventStore } from "../state/learning-event-store.js";
import type { RunLedgerStore } from "../state/run-ledger-store.js";
import { type ControlDecisionKind, decideControl } from "./decide.js";
import type { RunStateStore } from "./run-state-store.js";
import { assertLegalTransition } from "./state-machine.js";

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

/** Per-turn resource consumption reported by the run service. */
export interface TurnUsage {
  /**
   * Tokens consumed by the turn (AdapterOutput usage, 02 §4); null when the
   * runtime did not expose usage — the budget counter is left unchanged,
   * never fabricated.
   */
  tokens: number | null;
  /** Wall-clock minutes the turn took (execution + verification). */
  timeMinutes: number;
}

export interface ApplyJudgmentInput {
  loopId: string;
  runId: string;
  turn: number;
  goalId: string;
  workspaceRef: string;
  /** Whether the run's execution turn succeeded. */
  executionOk: boolean;
  /** Whether the verification layer ran (card requires phases). */
  verificationRan: boolean;
  /** Aggregated judgment_report; null when verification did not run. */
  judgment: JudgmentReport | null;
  /** artifact:// ref of judgment-report.json; null when verification did not run. */
  judgmentRef: string | null;
  /** Run creation time (ISO 8601), used for the state record's created_at. */
  createdAt: string;
  /** Budget limits from the IntentContract (数值唯一权威来源, 02 §2). */
  budget: BudgetLimits;
  /** This turn's consumption, accumulated into the run's budget snapshot. */
  usage: TurnUsage;
  /**
   * Set when the run was terminated by a unified adapter hard error
   * (02-schema契约.md §4). The failure attribution (失败模式账本 vocabulary)
   * is recorded on the control decision entry. Adapter hard errors are
   * terminal: they decide `failed` via executionOk=false and never bridge
   * to needs_human (see the run-service call-site comment).
   */
  adapterFailure?: {
    code: string;
    failureTag: FailureTag;
    message: string;
  };
  /**
   * Set when the policy projection intercepted a hard-gate / high-risk
   * action during the turn (05 阶段 2 验收 4: 硬闸门拦截升级 needs_human,
   * bypass 下仍被拦 — bypass ≠ 绕过硬闸门). Forces the control decision
   * to needs_human unless the turn already failed terminally; the policy
   * ref lands on the decision entry's policy_refs.
   */
  policyEscalation?: {
    action: string;
    reason: string;
    policyRef: string;
  };
  /**
   * 合约的非预算停止规则 (02 §2 stop_rules; 当前只有
   * repetition.max_same_failure 被消费: 同一阻断指纹重复超过上限即停,
   * needs_human 循环打断为终态 failed —— 预算与停止规则.md "同一
   * verifier 同一错误重复 → 停止或人工")。
   */
  stopRules?: IntentContract["stop_rules"];
  /** 本轮执行的 session 引用 (06 偏差 #32: run_state.session_ref,
   *  前端据此订阅对应 session 的消息流)。 */
  sessionRef?: string;
}

export interface ApplyJudgmentResult {
  state: ControlDecisionKind;
  entry: DecisionEntry;
  /** Budget snapshot after accumulating this turn (drives retry backoff). */
  budget: Budget;
  /** True when this exact transition was already ledgered (repeat trigger). */
  idempotent: boolean;
}

/**
 * ResumeSignal — a blocked run (needs_human / paused / budget_limited)
 * came back to active; the run service continues it with a new turn.
 */
export interface ResumeSignal {
  runId: string;
  loopId: string;
  cause:
    | "human_approve"
    | "human_request_changes"
    | "resume_signal"
    | "budget_supplemented";
  /** Human feedback to inject into the next turn's context, when given. */
  feedback?: string;
}

export interface BeginTurnResult {
  /** False when the pre-turn budget check stopped the run (budget_limited). */
  ok: boolean;
  state: RunState;
  record: RunStateRecord;
}

/**
 * Seed for pausing a run whose first turn is still in flight: turn 1 has no
 * run_state record yet (it is first written at judgment time), so PATCH
 * pause materializes one from the run service's execution context before
 * driving active → paused.
 */
export interface PauseSeed {
  runId: string;
  turn: number;
  goalId: string;
  workspaceRef: string;
  /** Contract budget limits; null when setup failed before a contract existed. */
  budget: BudgetLimits | null;
  createdAt: string;
  /** Session of the in-flight turn being killed, kept so a resume after a
   *  server restart can continue on the same session (06 #32); null when no
   *  session had started yet. */
  sessionRef?: string | null;
}

interface PendingApproval {
  loopId: string;
  requestId: string;
}

export interface ControlPlaneDeps {
  runStateStore: RunStateStore;
  runLedgerStore: RunLedgerStore;
  /** Optional: events are only broadcast when a bus is wired. */
  eventBus?: IEventBus;
  /**
   * Optional: learning_event sink (阶段 3). When wired, a run reaching a
   * terminal decision (complete / failed / budget_limited) or a decision
   * carrying failure_tags appends one learning_event to
   * learning/events.jsonl — fire-and-forget (只发不等), emission failures
   * are logged and never affect run progression.
   */
  learningEventStore?: LearningEventStore;
}

/** The options a needs_human run offers (03: full set). */
const DECISION_OPTIONS = ["approve", "reject", "request_changes", "pause"];

/** Deterministic decision_id = idempotency key (run_id + turn + target/cause). */
function controlDecisionId(runId: string, turn: number, to: RunState): string {
  return `decision-${runId}-t${turn}-${to}`;
}

function normalizeBlockerParts(parts: string[]): string[] {
  return parts
    .map((part) => part.trim().replace(/\s+/g, " ").toLowerCase())
    .filter((part) => part.length > 0)
    .sort();
}

function blockerFingerprint(
  judgment: JudgmentReport | null,
  policyEscalation?: ApplyJudgmentInput["policyEscalation"],
): string | undefined {
  if (!judgment && !policyEscalation) {
    return undefined;
  }
  const payload = {
    next_action: judgment?.next_action ?? "none",
    risks: normalizeBlockerParts(judgment?.unresolved_risks ?? []),
    evidence: normalizeBlockerParts(judgment?.evidence ?? []),
    policy_action: policyEscalation?.action ?? null,
    policy_reason: policyEscalation?.reason
      ? normalizeBlockerParts([policyEscalation.reason])[0]
      : null,
  };
  return `blocker:${createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 16)}`;
}

export class ControlPlane {
  private readonly deps: ControlPlaneDeps;
  /** run_id -> pending approval (in-memory index; rebuilt from state files) */
  private pending = new Map<string, PendingApproval>();
  /** run_id -> loop_id (in-memory index; rebuilt from state files on scan) */
  private runIndex = new Map<string, string>();
  /** run_id -> latest known state (drives API state projections) */
  private statesByRunId = new Map<string, RunState>();
  private resolvedListeners: ((runId: string, state: RunState) => void)[] = [];
  private resumeListeners: ((signal: ResumeSignal) => void)[] = [];
  /** In-flight fire-and-forget learning_event appends (settle hook for tests). */
  private pendingLearningEvents: Promise<void>[] = [];

  constructor(deps: ControlPlaneDeps) {
    this.deps = deps;
  }

  /** Latest known state for a run (undefined if never seen this process). */
  currentStateOf(runId: string): RunState | undefined {
    return this.statesByRunId.get(runId);
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
   * listens and continues the run with a new turn on the same session.
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
    this.runIndex.set(input.runId, input.loopId);
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
    const exhausted = this.exhaustedFields(budget, input.turn);
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
    this.maybeWarnBudget(input, budget);

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
    const repeatedBlockerCount = fingerprint
      ? (
          await this.deps.runLedgerStore.readDecisionEntries(input.runId)
        ).filter(
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
    } = await this.transition({
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
      failureTags: this.attributeFailureTags(input),
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
              }
            : null,
      },
    });

    if (!idempotent && decision.kind === "needs_human") {
      this.pending.set(input.runId, {
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
        options: DECISION_OPTIONS,
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
    const found = await this.findRun(runId);
    if (!found) {
      throw new ControlPlaneError("run_not_found", `Run '${runId}' not found`);
    }
    let { record } = found;
    const { loopId } = found;

    if (record.state === "retry") {
      const resumed = await this.transition({
        loopId,
        runId,
        record,
        to: "active",
        decision: "resumed",
        decisionId: `decision-${runId}-t${record.turn}-resumed-retry`,
        reason: `retry backoff elapsed; starting turn ${nextTurn} on the same session (retry #${record.budget?.used_retries ?? "?"})`,
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
      const exhausted = this.exhaustedAtTurnStart(budget);
      if (exhausted.length > 0) {
        const limited = await this.transition({
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
    action: RunDecisionAction,
    feedback?: string,
  ): Promise<RunStateRecord> {
    if (action === "request_changes" && !feedback?.trim()) {
      throw new ControlPlaneError(
        "invalid_decision",
        "feedback is required for request_changes (03: it is injected as context for the next turn)",
      );
    }

    const waiting = await this.findWaitingRun(runId);
    if (!waiting) {
      if (await this.runExists(runId)) {
        throw new ControlPlaneError(
          "invalid_state",
          `Run '${runId}' is not waiting for a human decision (not in needs_human)`,
        );
      }
      throw new ControlPlaneError("run_not_found", `Run '${runId}' not found`);
    }

    const { loopId, record } = waiting;
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
    const decisionKind: DecisionKind =
      target === "active"
        ? "resumed"
        : target === "failed"
          ? "failed"
          : "paused";

    const now = new Date().toISOString();
    const reasonByAction: Record<RunDecisionAction, string> = {
      approve:
        "human approved; run resumes with the human response carried back (03: needs_human → active)",
      reject: "human rejected the run",
      request_changes:
        "human requested changes; feedback is injected into the next turn's context (03: needs_human → active)",
      pause: "human paused the run from needs_human",
    };
    const { record: updated } = await this.transition({
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
    this.pending.delete(runId);

    if (target === "active") {
      this.notifyResume({
        runId,
        loopId,
        cause: action === "approve" ? "human_approve" : "human_request_changes",
        feedback,
      });
    } else if (target === "failed") {
      this.notifyResolved(runId, target);
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
   * 杀执行进程，partial result 丢弃，session_ref 保留供 resume)。
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
        // 首轮在飞被暂停: 被杀 turn 的 session 一并记录, 重启后 resume
        // 仍能续上同一 session (06 #32); 无 session (setup 失败) 为 null
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
    const { record: updated } = await this.transition({
      loopId,
      runId: record.run_id,
      record,
      to: "paused",
      decision: "paused",
      decisionId: controlDecisionId(record.run_id, record.turn, "paused"),
      reason:
        "human paused the run via PATCH /api/loops/:id (主动暂停, 不走审批管线; the executing process is killed and the partial turn result dropped — session_ref 保留供 resume)",
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
    const { record: updated } = await this.transition({
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
    this.notifyResume({
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
    const { record: updated } = await this.transition({
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
   * one or more max_* fields; the result is re-validated (max_retries <
   * max_turns still has to hold). Interface for the budget-resume control
   * endpoint, which lands with the routes slice.
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
    const { record: updated } = await this.transition({
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
    this.notifyResume({
      runId: record.run_id,
      loopId,
      cause: "budget_supplemented",
    });
    return updated;
  }

  /**
   * The single writer path for every state change: transition-table guard,
   * idempotent decision-ledger append, run_state save, in-memory indexes,
   * loop-state-changed broadcast. `record.state` is the from-state.
   */
  private async transition(opts: {
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
    override?: DecisionEntry["override"];
    patch?: Partial<RunStateRecord>;
  }): Promise<{
    record: RunStateRecord;
    entry: DecisionEntry;
    idempotent: boolean;
  }> {
    const { record, to, runId, loopId } = opts;
    assertLegalTransition(record.state, to, { runId, turn: record.turn });

    // Idempotent write: a repeated trigger of the same transition finds its
    // entry and does not append / re-save / re-emit.
    const entries = await this.deps.runLedgerStore.readDecisionEntries(runId);
    const existing = entries.find((e) => e.decision_id === opts.decisionId);
    if (existing) {
      return { record, entry: existing, idempotent: true };
    }

    const now = new Date().toISOString();
    const budget = opts.patch?.budget ?? record.budget;
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
      override: opts.override,
      failure_tags: opts.failureTags,
      // 账本可见逐轮消耗：每条决策携带落账时的预算快照。
      budget: budget ?? undefined,
      blocker_fingerprint: opts.blockerFingerprint,
      repeated_blocker_count: opts.repeatedBlockerCount,
      created_at: now,
    };
    await this.deps.runLedgerStore.appendDecisionEntry(runId, entry);

    const from = record.state;
    const updated: RunStateRecord = {
      ...record,
      ...opts.patch,
      state: to,
      updated_at: now,
    };
    await this.deps.runStateStore.save(loopId, updated);
    this.statesByRunId.set(runId, to);
    this.runIndex.set(runId, loopId);

    this.deps.eventBus?.emit({
      type: "loop-state-changed",
      loop_id: loopId,
      run_id: runId,
      from_state: from,
      to_state: to,
      turn: record.turn,
      reason: opts.reason,
      timestamp: now,
    });

    // 阶段 3 learning_event (02 §8.4): a terminal decision (complete /
    // failed / budget_limited) or a decision carrying failure_tags emits
    // one learning signal for the async learning worker. Fire-and-forget
    // (只发不等): the append is not awaited and any emission failure is
    // logged by emitLearningEvent, never propagated — 主链路对学习零感知.
    if (
      to === "complete" ||
      to === "failed" ||
      to === "budget_limited" ||
      (entry.failure_tags?.length ?? 0) > 0
    ) {
      this.emitLearningEvent({
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
      });
    }

    return { record: updated, entry, idempotent: false };
  }

  /**
   * Append a learning_event without awaiting it (02 §8.4: 主链路发出后即
   * 继续，不等学习结果). Any failure (schema, IO — e.g. EACCES on
   * events.jsonl) is caught and logged here; run progression is unaffected.
   */
  private emitLearningEvent(event: LearningEvent): void {
    const store = this.deps.learningEventStore;
    if (!store) {
      return;
    }
    const pending: Promise<void> = store.appendEvent(event).catch((error) => {
      console.error(
        `[ControlPlane] learning_event emit failed for run ${event.run_id} (只发不等, run 推进不受影响):`,
        error,
      );
    });
    this.pendingLearningEvents.push(pending);
    void pending.finally(() => {
      const index = this.pendingLearningEvents.indexOf(pending);
      if (index >= 0) {
        this.pendingLearningEvents.splice(index, 1);
      }
    });
  }

  /**
   * Test hook: wait for in-flight fire-and-forget learning_event appends.
   * Production code never awaits emissions (只发不等).
   */
  async settleLearningEvents(): Promise<void> {
    await Promise.all(this.pendingLearningEvents);
  }

  /**
   * 失败归因挂载 (修复计划 #21): 把本决策的归因信号映射为失败模式账本
   * 8 值词汇, 去重; 无信号返回 undefined (条目缺省空数组)。只挂有真实
   * 生产信号的类型, 不伪造 intent/context/memory_packet/eval_regression。
   */
  private attributeFailureTags(
    input: ApplyJudgmentInput,
  ): FailureTag[] | undefined {
    const tags = new Set<FailureTag>();
    if (input.adapterFailure) {
      tags.add(input.adapterFailure.failureTag);
    }
    if (input.policyEscalation) {
      tags.add("policy_error");
    }
    if (
      input.judgment &&
      (input.judgment.overall === "failed" ||
        input.judgment.overall === "inconclusive")
    ) {
      tags.add("verification_error");
    }
    return tags.size > 0 ? [...tags] : undefined;
  }

  /**
   * 03 "loop-budget-warning": budget 消耗越过 80% 阈值时广播, 一次/run/
   * 字段 (内存去重; 进程重启后同一 run 再次越界会重发一次, 可接受 —
   * 告警不是事实源, run_state 才是)。
   */
  private readonly budgetWarned = new Set<string>();

  private maybeWarnBudget(input: ApplyJudgmentInput, budget: Budget): void {
    if (!this.deps.eventBus) {
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
      if (this.budgetWarned.has(key)) {
        continue;
      }
      this.budgetWarned.add(key);
      this.deps.eventBus.emit({
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

  /**
   * Which budget fields are exhausted. `completedTurns` is the number of
   * finished turns (max_turns 含首轮: starting another turn requires
   * completedTurns < max_turns). max_tokens == 0 means untracked.
   */
  private exhaustedFields(budget: Budget, completedTurns: number): string[] {
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
  private exhaustedAtTurnStart(budget: Budget): string[] {
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

  private notifyResume(signal: ResumeSignal): void {
    for (const listener of this.resumeListeners) {
      try {
        listener(signal);
      } catch (error) {
        console.error("[ControlPlane] resume listener error:", error);
      }
    }
  }

  private notifyResolved(runId: string, state: RunState): void {
    for (const listener of this.resolvedListeners) {
      try {
        listener(runId, state);
      } catch (error) {
        console.error("[ControlPlane] resolved listener error:", error);
      }
    }
  }

  /** Locate a run's state record by run_id (index first, then a file scan). */
  private async findRun(
    runId: string,
  ): Promise<{ loopId: string; record: RunStateRecord } | null> {
    const loopId = this.runIndex.get(runId);
    if (loopId) {
      const record = await this.deps.runStateStore.load(loopId);
      if (record && (record.run_id === runId || record.run_id === "")) {
        return { loopId, record };
      }
    }
    const states = await this.deps.runStateStore.list();
    for (const state of states) {
      if (state.state.run_id === runId) {
        this.runIndex.set(runId, state.loopId);
        return { loopId: state.loopId, record: state.state };
      }
    }
    return null;
  }

  /**
   * Locate a needs_human run: in-memory index first, then a scan of the
   * persisted state files (covers server restarts — a waiting run's
   * pending_approval survives in state/<loop_id>.json).
   */
  private async findWaitingRun(
    runId: string,
  ): Promise<{ loopId: string; record: RunStateRecord } | null> {
    const pendingInfo = this.pending.get(runId);
    if (pendingInfo) {
      const record = await this.deps.runStateStore.load(pendingInfo.loopId);
      if (record?.state === "needs_human") {
        return { loopId: pendingInfo.loopId, record };
      }
    }
    const states = await this.deps.runStateStore.list();
    for (const { loopId, state } of states) {
      if (
        state.state === "needs_human" &&
        state.pending_approval?.run_id === runId
      ) {
        // Rebuild the in-memory index for subsequent calls.
        this.pending.set(runId, {
          loopId,
          requestId: state.pending_approval.request_id,
        });
        this.runIndex.set(runId, loopId);
        return { loopId, record: state };
      }
    }
    return null;
  }

  /** A run "exists" if it has a ledger file or a known in-memory state. */
  private async runExists(runId: string): Promise<boolean> {
    if (this.statesByRunId.has(runId)) {
      return true;
    }
    return (await this.deps.runLedgerStore.readEntry(runId)) !== null;
  }
}
