import { useCallback, useEffect, useState } from "react";
import { type LoopRunSummary, type StoredLoop, loopsApi } from "../api/loops";
import { activityBus } from "../lib/activityBus";

export interface LoopListEntry {
  loop: StoredLoop;
  /** Latest run (runs are newest-first), undefined when never run or on error */
  lastRun?: LoopRunSummary;
}

const LOOP_REFRESH_EVENTS = [
  "run-started",
  "turn-started",
  "turn-completed",
  "verification-started",
  "verification-completed",
  "relation-state-changed",
  "feedback-received",
  "loop-state-changed",
  "run-decision-required",
] as const;

/**
 * REST-backed loop list with activity-event invalidation. This replaces
 * mount-only useState loads so run lifecycle events refresh the list while
 * a user is watching it.
 */
export function useLoops(): {
  entries: LoopListEntry[];
  loading: boolean;
  error: Error | null;
  reload: () => Promise<void>;
} {
  const [entries, setEntries] = useState<LoopListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const reload = useCallback(async () => {
    try {
      const { loops } = await loopsApi.listLoops();
      const visible = loops.filter((loop) => !loop.archived);
      const withRuns = await Promise.all(
        visible.map(async (loop): Promise<LoopListEntry> => {
          try {
            const { runs } = await loopsApi.listRuns(loop.id);
            return { loop, lastRun: runs[0] };
          } catch {
            return { loop };
          }
        }),
      );
      setEntries(
        [...withRuns].sort((a, b) =>
          (b.lastRun?.created_at ?? "").localeCompare(
            a.lastRun?.created_at ?? "",
          ),
        ),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const unsubs = LOOP_REFRESH_EVENTS.map((eventType) =>
      activityBus.on(eventType, (event) => {
        if ("loop_id" in event && typeof event.loop_id === "string") {
          void reload();
        }
      }),
    );
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [reload]);

  return { entries, loading, error, reload };
}
