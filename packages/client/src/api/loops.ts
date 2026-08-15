import type {
  HumanReason,
  LoopAction,
  LoopCard,
  RunDecisionAction,
  RunState,
} from "@yep-anywhere/shared";
import { fetchJSON } from "./client";

/**
 * Loop registry API types + methods (spec: docs/spec/03-API契约.md).
 * Server routes: packages/server/src/routes/loops.ts and runs.ts.
 */

/** A registered loop as stored by the server's LoopCardStore. */
export interface StoredLoop {
  id: string;
  card: LoopCard;
  created_at: string;
  updated_at: string;
  archived: boolean;
}

/** One run in the run list projection (active runs + finished ledger entries). */
export interface LoopRunSummary {
  run_id: string;
  loop_id: string;
  /** "active" while in flight; afterwards the ledger entry's final_status */
  state: RunState;
  source: string;
  created_at: string;
}

/** Loop registry entry with the latest run projection bundled server-side. */
export interface LoopWithRun {
  loop: StoredLoop;
  last_run: LoopRunSummary | null;
}

/** 运行账本 / 决策账本的摘要投影 (GET /api/runs/:id). */
export interface LedgerSummary {
  turns_used: number;
  retries_used: number;
  /** 合约预算上限；run_state 不属于该 run 时为 null */
  max_turns: number | null;
  max_retries: number | null;
  /** 最新一条决策（解释 run 为何处于当前状态，如 paused 的原因） */
  last_decision: {
    decision: string;
    reason: string;
    human_reasons?: HumanReason[];
  } | null;
  verifier_report_refs: string[];
  judgment_report_ref: string | null;
  collector_report_ref: string | null;
  handoff_ref: string | null;
  blocker_fingerprint: string | null;
  repeated_blocker_count: number;
  /** judgment_report 摘要（overall / next_action / requires_human） */
  judgment_summary: {
    overall: string;
    next_action: string;
    requires_human: boolean;
  } | null;
  decision_refs: string[];
  failure_tags: string[];
}

export interface RunDetail {
  run: LoopRunSummary;
  ledger_summary: LedgerSummary;
  /** Session ref of the executor process (for live stream subscription). */
  session_ref: string | null;
}

export interface RunTurnSummary {
  turn: number;
  status: RunState;
  decision?: string;
  source?: string;
  created_at: string;
  stdout_ref: string | null;
  judgment_ref: string | null;
  executor_summary_ref: string | null;
}

export interface HumanSlaItem {
  run_id: string;
  loop_id: string;
  state: RunState;
  request_id: string | null;
  reason: string;
  entered_at: string;
  reminder_at: string;
  abandon_at: string;
  policy: "keep" | "auto_abandon" | "auto_approve_low_risk";
  reminder_due: boolean;
  abandon_due: boolean;
  last_reminder_at: string | null;
  human_reasons?: HumanReason[];
}

export interface LoopCoverageItem {
  target_id: string;
  loop_id: string;
  state: string;
  repository?: unknown;
  issue_number?: unknown;
  pr_number?: unknown;
  updated_at: string;
}

export interface InteractionDepsStatus {
  status: "ready" | "missing" | "unsupported";
  message: string;
  installCommand?: string;
}

const LOOP_LIST_LIMIT = 500;

export const loopsApi = {
  listLoops: (limit = LOOP_LIST_LIMIT) =>
    fetchJSON<{ loops: StoredLoop[] }>(`/loops?limit=${limit}`),

  listLoopsWithRuns: (limit = LOOP_LIST_LIMIT) =>
    fetchJSON<{ loops: LoopWithRun[] }>(`/loops?limit=${limit}&with_runs=1`),

  createLoop: (card: LoopCard) =>
    fetchJSON<{ loop: StoredLoop }>("/loops", {
      method: "POST",
      body: JSON.stringify(card),
    }),

  getLoop: (loopId: string) =>
    fetchJSON<{
      loop: StoredLoop;
      current_run_state: unknown;
      last_run_summary: unknown;
    }>(`/loops/${encodeURIComponent(loopId)}`),

  getInteractionDeps: (loopId: string) =>
    fetchJSON<InteractionDepsStatus>(
      `/loops/${encodeURIComponent(loopId)}/interaction-deps`,
    ),

  installInteractionDeps: (loopId: string, installCommand?: string) =>
    fetchJSON<{ ok: boolean; command: string; output: string }>(
      `/loops/${encodeURIComponent(loopId)}/interaction-deps/install`,
      {
        method: "POST",
        body: JSON.stringify(
          installCommand ? { install_command: installCommand } : {},
        ),
      },
    ),

  listRuns: (loopId: string) =>
    fetchJSON<{ runs: LoopRunSummary[] }>(
      `/loops/${encodeURIComponent(loopId)}/runs`,
    ),

  getRun: (runId: string) =>
    fetchJSON<RunDetail>(`/runs/${encodeURIComponent(runId)}`),

  /** Manually trigger one run. 409 run_active when a run is in flight. */
  triggerRun: (loopId: string) =>
    fetchJSON<{ run: LoopRunSummary }>(
      `/loops/${encodeURIComponent(loopId)}/runs`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  /**
   * PATCH pause / resume / archive (03-API契约.md, 阶段 2). pause on an
   * active run kills the executing process (partial result dropped) and
   * parks the run; resume continues it from the next turn on the same
   * session. 409 invalid_state for illegal transitions.
   */
  patchLoop: (loopId: string, action: LoopAction) =>
    fetchJSON<{ loop_id: string; current_run_state: RunState | null }>(
      `/loops/${encodeURIComponent(loopId)}`,
      { method: "PATCH", body: JSON.stringify({ action }) },
    ),

  /** Human answer for a needs_human run. request_changes requires feedback. */
  submitDecision: (
    runId: string,
    decision: RunDecisionAction,
    feedback?: string,
  ) =>
    fetchJSON<{ run_state: unknown }>(
      `/runs/${encodeURIComponent(runId)}/decision`,
      {
        method: "POST",
        body: JSON.stringify({ decision, feedback }),
      },
    ),

  /** List artifact file names written for a run. */
  listRunArtifacts: (runId: string) =>
    fetchJSON<{ artifacts: string[] }>(
      `/runs/${encodeURIComponent(runId)}/artifacts`,
    ),

  /** Read one artifact's content for a run. */
  getRunArtifact: (runId: string, name: string) =>
    fetchJSON<{ content: string }>(
      `/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`,
    ),

  listRunTurns: (runId: string) =>
    fetchJSON<{ turns: RunTurnSummary[] }>(
      `/runs/${encodeURIComponent(runId)}/turns`,
    ),

  listPendingHuman: () => fetchJSON<{ items: HumanSlaItem[] }>("/runs/pending"),

  getCoverage: (repository: string, issueNumber?: number) =>
    fetchJSON<{ coverage: LoopCoverageItem[] }>(
      `/loops/coverage?repository=${encodeURIComponent(repository)}${
        issueNumber === undefined
          ? ""
          : `&issue_number=${encodeURIComponent(issueNumber)}`
      }`,
    ),

  /** Discard one run and optionally revert/clean up its workspace changes. */
  discardRun: (
    runId: string,
    body: {
      reason: string;
      revert_files?: boolean;
      cleanup_worktree?: boolean;
      force?: boolean;
    },
  ) =>
    fetchJSON<{ run_state: unknown; discard_result_ref: string }>(
      `/runs/${encodeURIComponent(runId)}/discard`,
      { method: "POST", body: JSON.stringify(body) },
    ),
};
