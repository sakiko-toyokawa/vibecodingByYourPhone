import type { ControlPlane } from "../control-plane/control-plane.js";
import type { MaintenanceTargetStore } from "../maintenance/maintenance-target-store.js";
import type { RelationLifecycleService } from "../relation/lifecycle-service.js";
import { LoopRunError, type LoopRunService } from "../run-service.js";
import type { TriggerQueueStore } from "../state/trigger-queue-store.js";
import {
  type TriggerPayloadSource,
  parseTriggerPayload,
} from "./trigger-payload.js";

export interface TriggerDispatcherDeps {
  queueStore: TriggerQueueStore;
  runService: LoopRunService;
  controlPlane: ControlPlane;
  maintenanceTargetStore?: MaintenanceTargetStore;
  relationLifecycle?: RelationLifecycleService;
}

export interface DrainPendingTriggersOptions {
  /** Rethrow dispatch failures instead of only marking the queue entry. */
  throwOnError?: boolean;
}

/**
 * Drain pending external trigger events. Same-loop runs stay serial; a
 * pending event is left for the next drain when the loop is busy.
 */
export async function drainPendingTriggers(
  deps: TriggerDispatcherDeps,
  loopId?: string,
  options: DrainPendingTriggersOptions = {},
): Promise<void> {
  for (const entry of await deps.queueStore.listPending(loopId)) {
    const payload = parseTriggerPayload(
      entry.source as TriggerPayloadSource,
      entry.payload,
    );
    if (entry.source === "resume") {
      const runId = payload.run_id ?? null;
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
      if (options.throwOnError) {
        throw new LoopRunError(
          "run_active",
          `Loop '${entry.loop_id}' already has an active run`,
        );
      }
      continue;
    }
    const source =
      entry.source === "issue"
        ? "webhook"
        : (entry.source as "cron" | "manual" | "webhook");
    try {
      const relationId = payload.relation_id;
      const maintenanceId = payload.maintenance_id;
      await deps.runService.startRun(entry.loop_id, source, undefined, {
        relationId,
        maintenanceId,
      });
      if (maintenanceId) {
        const relationTransitioned = await deps.relationLifecycle?.transition(
          maintenanceId,
          "fixing",
          {},
          {
            event: "fixing",
            message: `trigger ${entry.event_id} dispatched maintenance ${maintenanceId}`,
          },
        );
        if (!relationTransitioned) {
          await deps.maintenanceTargetStore?.updateState(
            maintenanceId,
            "fixing",
          );
        }
      }
      await deps.queueStore.mark(entry.event_id, "done");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("already has an active run")) {
        if (options.throwOnError) throw error;
        continue;
      }
      await deps.queueStore.mark(entry.event_id, "failed", message);
      if (options.throwOnError) throw error;
    }
  }
}
