import type { ControlPlane } from "../control-plane/control-plane.js";
import type { LoopRunService } from "../run-service.js";
import type { TriggerQueueStore } from "../state/trigger-queue-store.js";

export interface TriggerDispatcherDeps {
  queueStore: TriggerQueueStore;
  runService: LoopRunService;
  controlPlane: ControlPlane;
}

/**
 * Drain pending external trigger events. Same-loop runs stay serial; a
 * pending event is left for the next drain when the loop is busy.
 */
export async function drainPendingTriggers(
  deps: TriggerDispatcherDeps,
  loopId?: string,
): Promise<void> {
  for (const entry of await deps.queueStore.listPending(loopId)) {
    if (entry.source === "resume") {
      const runId =
        typeof entry.payload.run_id === "string" ? entry.payload.run_id : null;
      const record = await deps.controlPlane.getRunState(entry.loop_id);
      if (runId && record?.state === "paused" && record.run_id === runId) {
        try {
          await deps.controlPlane.resumePaused(entry.loop_id);
          await deps.queueStore.mark(entry.event_id, "done");
        } catch (error) {
          await deps.queueStore.mark(
            entry.event_id,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
        }
      } else {
        await deps.queueStore.mark(
          entry.event_id,
          "failed",
          "resume event did not match a paused run",
        );
      }
      continue;
    }

    if (deps.runService.isRunActive(entry.loop_id)) {
      continue;
    }
    const source = entry.source === "issue" ? "webhook" : entry.source;
    try {
      const relationId =
        typeof entry.payload.relation_id === "string"
          ? entry.payload.relation_id
          : undefined;
      await deps.runService.startRun(entry.loop_id, source, undefined, {
        relationId,
      });
      await deps.queueStore.mark(entry.event_id, "done");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("already has an active run")) {
        continue;
      }
      await deps.queueStore.mark(entry.event_id, "failed", message);
    }
  }
}
