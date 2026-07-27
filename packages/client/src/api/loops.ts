import type {
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

/** 运行账本 / 决策账本的摘要投影 (GET /api/runs/:id). */
export interface LedgerSummary {
  turns_used: number;
  retries_used: number;
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
}

export const loopsApi = {
  listLoops: () => fetchJSON<{ loops: StoredLoop[] }>("/loops"),

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
};
