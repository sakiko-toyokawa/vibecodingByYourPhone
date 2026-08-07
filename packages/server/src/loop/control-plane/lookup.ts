/**
 * Run lookup helpers for the control plane.
 *
 * Extracted from control-plane.ts during Phase-3 refactoring.
 */

import type { RunStateRecord } from "@yep-anywhere/shared";
import type {
  ControlPlaneDeps,
  ControlPlaneState,
  PendingApproval,
} from "./types.js";

/** Locate a run's state record by run_id (index first, then a file scan). */
export async function findRun(
  deps: ControlPlaneDeps,
  state: ControlPlaneState,
  runId: string,
): Promise<{ loopId: string; record: RunStateRecord } | null> {
  const loopId = state.runIndex.get(runId);
  if (loopId) {
    const record = await deps.runStateStore.load(loopId);
    if (record && (record.run_id === runId || record.run_id === "")) {
      return { loopId, record };
    }
  }
  const states = await deps.runStateStore.list();
  for (const s of states) {
    if (s.state.run_id === runId) {
      state.runIndex.set(runId, s.loopId);
      return { loopId: s.loopId, record: s.state };
    }
  }
  return null;
}

/**
 * Locate a needs_human run: in-memory index first, then a scan of the
 * persisted state files (covers server restarts — a waiting run's
 * pending_approval survives in state/<loop_id>.json).
 */
export async function findWaitingRun(
  deps: ControlPlaneDeps,
  state: ControlPlaneState,
  runId: string,
): Promise<{ loopId: string; record: RunStateRecord } | null> {
  const pendingInfo = state.pending.get(runId);
  if (pendingInfo) {
    const record = await deps.runStateStore.load(pendingInfo.loopId);
    if (record?.state === "needs_human") {
      return { loopId: pendingInfo.loopId, record };
    }
  }
  const states = await deps.runStateStore.list();
  for (const { loopId, state: s } of states) {
    if (s.state === "needs_human" && s.pending_approval?.run_id === runId) {
      // Rebuild the in-memory index for subsequent calls.
      state.pending.set(runId, {
        loopId,
        requestId: s.pending_approval.request_id,
      });
      state.runIndex.set(runId, loopId);
      return { loopId, record: s };
    }
  }
  return null;
}

/** A run "exists" if it has a ledger file or a known in-memory state. */
export async function runExists(
  deps: ControlPlaneDeps,
  state: ControlPlaneState,
  runId: string,
): Promise<boolean> {
  if (state.statesByRunId.has(runId)) {
    return true;
  }
  return (await deps.runLedgerStore.readEntry(runId)) !== null;
}
