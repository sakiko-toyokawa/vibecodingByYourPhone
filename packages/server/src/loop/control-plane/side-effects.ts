/**
 * Control-plane side effects: event emission, listener notification,
 * learning_event sink, and .loop/STATE.md projection.
 *
 * Extracted from control-plane.ts during Phase-3 refactoring.
 */

import path from "node:path";
import type {
  LearningEvent,
  RunState,
  RunStateRecord,
} from "@yep-anywhere/shared";
import { projectStateMd } from "../state/state-md-projection.js";
import type { ResumeSignal } from "./types.js";
import type { ControlPlaneDeps, ControlPlaneState } from "./types.js";

export type ResolvedListener = (runId: string, state: RunState) => void;
export type ResumeListener = (signal: ResumeSignal) => void;

export function notifyResume(
  listeners: ResumeListener[],
  signal: ResumeSignal,
): void {
  for (const listener of listeners) {
    try {
      listener(signal);
    } catch (error) {
      console.error("[ControlPlane] resume listener error:", error);
    }
  }
}

export function notifyResolved(
  listeners: ResolvedListener[],
  runId: string,
  state: RunState,
): void {
  for (const listener of listeners) {
    try {
      listener(runId, state);
    } catch (error) {
      console.error("[ControlPlane] resolved listener error:", error);
    }
  }
}

/**
 * Append a learning_event without awaiting it (02 §8.4: 主链路发出后即
 * 继续，不等学习结果). Any failure (schema, IO — e.g. EACCES on
 * events.jsonl) is caught and logged here; run progression is unaffected.
 */
export function emitLearningEvent(
  deps: ControlPlaneDeps,
  state: ControlPlaneState,
  event: LearningEvent,
): void {
  const store = deps.learningEventStore;
  if (!store) {
    return;
  }
  const pending: Promise<void> = store.appendEvent(event).catch((error) => {
    console.error(
      `[ControlPlane] learning_event emit failed for run ${event.run_id} (只发不等, run 推进不受影响):`,
      error,
    );
  });
  state.pendingLearningEvents.push(pending);
  void pending.finally(() => {
    const index = state.pendingLearningEvents.indexOf(pending);
    if (index >= 0) {
      state.pendingLearningEvents.splice(index, 1);
    }
  });
}

/**
 * Test hook: wait for in-flight fire-and-forget learning_event appends.
 * Production code never awaits emissions (只发不等).
 */
export async function settleLearningEvents(
  state: ControlPlaneState,
): Promise<void> {
  await Promise.all(state.pendingLearningEvents);
}

/**
 * Fire-and-forget .loop/STATE.md 投影 (04-存储约定)。从 LoopCard 取
 * workspace.path (原仓库路径 —— worktree 策略下投影仍写原 workspace,
 * 口径见 state-md-projection.ts 文件头) 与 persistence.state_file;
 * card 缺失或未配 workspace.path 时跳过 (投影无目标, 不算错误).
 * projectStateMd 自身绝不抛, 这里的 .catch 只是兜底。
 */
export function emitStateMdProjection(
  deps: ControlPlaneDeps,
  state: ControlPlaneState,
  loopId: string,
  record: RunStateRecord,
): void {
  const store = deps.loopCardStore;
  if (!store) {
    return;
  }
  const card = store.getLoop(loopId)?.card;
  const workspacePath = card?.loop.workspace.path;
  if (!card || !workspacePath) {
    return;
  }
  let resolvedWorkspacePath = workspacePath;
  if (workspacePath.startsWith("managed://")) {
    const dataDir = deps.dataDir;
    if (!dataDir) {
      console.warn(
        `[ControlPlane] STATE.md projection skipped for loop ${loopId}: managed:// workspace requires dataDir`,
      );
      return;
    }
    resolvedWorkspacePath = workspacePath.replace(
      /^managed:\/\/github-workspaces\/prompt-loops\/(.+)$/,
      path.join(dataDir, "github-workspaces", "prompt-loops", "$1"),
    );
  }
  const pending: Promise<void> = projectStateMd({
    workspacePath: resolvedWorkspacePath,
    stateFile: card.loop.persistence.state_file,
    snapshot: {
      loopId,
      runId: record.run_id,
      state: record.state,
      turn: record.turn,
      budget: record.budget,
      sessionRef: record.session_ref,
      updatedAt: record.updated_at,
    },
  }).catch((error) => {
    console.warn(
      `[ControlPlane] STATE.md projection failed for loop ${loopId} (只发不等, run 推进不受影响):`,
      error,
    );
  });
  state.pendingStateMdProjections.push(pending);
  void pending.finally(() => {
    const index = state.pendingStateMdProjections.indexOf(pending);
    if (index >= 0) {
      state.pendingStateMdProjections.splice(index, 1);
    }
  });
}

/**
 * Test hook: wait for in-flight fire-and-forget STATE.md projections.
 * Production code never awaits projections (只发不等).
 */
export async function settleStateMdProjections(
  state: ControlPlaneState,
): Promise<void> {
  await Promise.all(state.pendingStateMdProjections);
}
