/**
 * Minimal control-plane (spec: docs/spec/05-分阶段计划.md 阶段 1,
 * 03-API契约.md "POST /api/runs/:id/decision" + WS 事件契约).
 *
 * Phase-1 scope — deliberately minimal (the full 7-state machine with retry
 * backoff and budget enforcement is phase 2):
 *
 *  - applyJudgment(): after a run's verification, decideControl() maps the
 *    judgment_report to complete / needs_human / failed, the run_state
 *    snapshot is persisted (state/<loop_id>.json, control-plane is the only
 *    writer per 04-存储约定), a decision_entry is appended to
 *    runs/<run_id>.jsonl, and `loop-state-changed` is broadcast.
 *
 *  - needs_human bridging: when the decision is needs_human the run blocks.
 *    `run-decision-required` is broadcast on the activity channel and the
 *    pending approval is tracked (in memory + in the persisted run_state, so
 *    a server restart can re-discover waiting runs from state files). The
 *    human answer arrives via submitDecision() (POST /api/runs/:id/decision),
 *    which transitions the run, appends a decision_entry carrying the
 *    override record (original_judgment_ref + reason + feedback), broadcasts
 *    `loop-state-changed`, and notifies resolved listeners (the run service
 *    releases its in-memory active-run registration).
 *
 * Phase-1 deviation from 03's transition table (recorded in the slice
 * report): approve → complete and request_changes → failed instead of
 * 03's needs_human → active, because phase 1 runs are single-turn — there
 * is no next turn to resume into (resume semantics arrive with the phase-2
 * state machine). The human verdicts are recorded as judgment overrides in
 * the decision ledger, which is the audit trail 03/05 require.
 *
 * TODO(phase-2): pause lands on the `paused` state and is recorded, but
 * there is no resume mechanism yet — paused → active via PATCH resume is
 * owned by the phase-2 state machine (05 阶段 2 "paused / resume 控制端点").
 */

import { randomUUID } from "node:crypto";
import type {
  DecisionEntry,
  JudgmentReport,
  RunDecisionAction,
  RunState,
  RunStateRecord,
} from "@yep-anywhere/shared";
import type { IEventBus } from "../../watcher/index.js";
import type { RunLedgerStore } from "../state/run-ledger-store.js";
import { type ControlDecisionKind, decideControl } from "./decide.js";
import type { RunStateStore } from "./run-state-store.js";

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
}

export interface ApplyJudgmentResult {
  state: ControlDecisionKind;
  entry: DecisionEntry;
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
}

/** The options a needs_human run offers (03: full set in phase 1). */
const DECISION_OPTIONS = ["approve", "reject", "request_changes", "pause"];

export class ControlPlane {
  private readonly deps: ControlPlaneDeps;
  /** run_id -> pending approval (in-memory index; rebuilt from state files) */
  private pending = new Map<string, PendingApproval>();
  /** run_id -> latest known state (drives API state projections) */
  private statesByRunId = new Map<string, RunState>();
  private resolvedListeners: ((runId: string, state: RunState) => void)[] = [];

  constructor(deps: ControlPlaneDeps) {
    this.deps = deps;
  }

  /** Latest known state for a run (undefined if never seen this process). */
  currentStateOf(runId: string): RunState | undefined {
    return this.statesByRunId.get(runId);
  }

  /**
   * Called when a waiting run leaves needs_human (human decision answered).
   * The run service uses it to release its in-memory active-run registration.
   */
  onRunResolved(listener: (runId: string, state: RunState) => void): void {
    this.resolvedListeners.push(listener);
  }

  /**
   * Apply a run's judgment: decide, persist run_state, append the control
   * decision_entry, broadcast loop-state-changed, and bridge needs_human.
   */
  async applyJudgment(input: ApplyJudgmentInput): Promise<ApplyJudgmentResult> {
    const decision = decideControl({
      executionOk: input.executionOk,
      verificationRan: input.verificationRan,
      judgment: input.judgment,
    });

    const now = new Date().toISOString();
    const requestId = `decision-${input.runId}-control`;
    const entry: DecisionEntry = {
      decision_id: requestId,
      loop_id: input.loopId,
      run_id: input.runId,
      decision: decision.kind,
      reason: decision.reason,
      evidence_refs: input.judgment?.evidence ?? [],
      policy_refs: [], // phase 1: no policy projection
      next_action:
        decision.kind === "needs_human" ? "wait_for_approval" : "none",
      created_at: now,
    };
    await this.deps.runLedgerStore.appendDecisionEntry(input.runId, entry);

    const record: RunStateRecord = {
      version: 1,
      goal_id: input.goalId,
      state: decision.kind,
      turn: input.turn,
      intent_version: 1,
      workspace_ref: input.workspaceRef,
      last_judgment: input.judgmentRef,
      pending_approval:
        decision.kind === "needs_human"
          ? {
              request_id: requestId,
              run_id: input.runId,
              reason: decision.reason,
              entered_at: now,
            }
          : null,
      created_at: input.createdAt,
      updated_at: now,
    };
    await this.deps.runStateStore.save(input.loopId, record);
    this.statesByRunId.set(input.runId, decision.kind);

    this.deps.eventBus?.emit({
      type: "loop-state-changed",
      loop_id: input.loopId,
      run_id: input.runId,
      from_state: "active",
      to_state: decision.kind,
      turn: input.turn,
      reason: decision.reason,
      timestamp: now,
    });

    if (decision.kind === "needs_human") {
      this.pending.set(input.runId, {
        loopId: input.loopId,
        requestId,
      });
      this.deps.eventBus?.emit({
        type: "run-decision-required",
        loop_id: input.loopId,
        run_id: input.runId,
        request_id: requestId,
        // Phase 1 has no policy projection / hard gates; the action is the
        // judgment's suggested next step.
        action: input.judgment?.next_action ?? "manual_review",
        risk: "unrated",
        reason: decision.reason,
        evidence_refs: input.judgment?.evidence ?? [],
        options: DECISION_OPTIONS,
        timestamp: now,
      });
    }

    return { state: decision.kind, entry };
  }

  /**
   * Answer a needs_human run (POST /api/runs/:id/decision).
   *
   * Phase-1 transition table (deviation from 03 — see module comment):
   *   approve          → complete (human overrides the judgment)
   *   reject           → failed   (human rejection terminates the run)
   *   request_changes  → failed   (feedback recorded for the next run)
   *   pause            → paused   (TODO phase-2: resume mechanism)
   */
  async submitDecision(
    runId: string,
    action: RunDecisionAction,
    feedback?: string,
  ): Promise<RunStateRecord> {
    if (action === "request_changes" && !feedback?.trim()) {
      throw new ControlPlaneError(
        "invalid_decision",
        "feedback is required for request_changes (03: it is injected as context for the next run)",
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
    const target: RunState =
      action === "approve"
        ? "complete"
        : action === "pause"
          ? "paused"
          : "failed";

    const now = new Date().toISOString();
    const reasonByAction: Record<RunDecisionAction, string> = {
      approve: "human approved the run, overriding the judgment",
      reject: "human rejected the run",
      request_changes:
        "human requested changes; feedback recorded for the next run",
      pause: "human paused the run from needs_human",
    };
    const entry: DecisionEntry = {
      decision_id: `decision-${runId}-human-${randomUUID().slice(0, 8)}`,
      loop_id: loopId,
      run_id: runId,
      decision: target,
      reason: reasonByAction[action],
      evidence_refs: [],
      policy_refs: [],
      // TODO(phase-2): paused resumes via a resume signal (PATCH resume);
      // the mechanism is owned by the phase-2 state machine.
      next_action: target === "paused" ? "wait_for_resume_signal" : "none",
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
      created_at: now,
    };
    await this.deps.runLedgerStore.appendDecisionEntry(runId, entry);

    const updated: RunStateRecord = {
      ...record,
      state: target,
      pending_approval: null,
      updated_at: now,
    };
    await this.deps.runStateStore.save(loopId, updated);
    this.statesByRunId.set(runId, target);
    this.pending.delete(runId);

    this.deps.eventBus?.emit({
      type: "loop-state-changed",
      loop_id: loopId,
      run_id: runId,
      from_state: "needs_human",
      to_state: target,
      turn: record.turn,
      reason: reasonByAction[action],
      timestamp: now,
    });

    for (const listener of this.resolvedListeners) {
      try {
        listener(runId, target);
      } catch (error) {
        console.error("[ControlPlane] resolved listener error:", error);
      }
    }

    return updated;
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
