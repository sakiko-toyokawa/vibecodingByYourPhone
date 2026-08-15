import { useCallback, useEffect, useState } from "react";
import { type RunDetail, type RunTurnSummary, loopsApi } from "../api/loops";
import { activityBus } from "../lib/activityBus";

const RUN_REFRESH_EVENTS = [
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
 * Run detail + artifacts + turn history, invalidated by activity events.
 * Also tracks the live executor session from turn/verifier events so a run
 * can switch streams without waiting for the next REST projection.
 */
export function useRun(
  loopId?: string | null,
  runId?: string | null,
): {
  runDetail: RunDetail | null;
  artifacts: string[];
  runTurns: RunTurnSummary[];
  loading: boolean;
  error: Error | null;
  sessionRef: string | null;
  refresh: () => Promise<void>;
} {
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [artifacts, setArtifacts] = useState<string[]>([]);
  const [runTurns, setRunTurns] = useState<RunTurnSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [sessionRef, setSessionRef] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!runId) {
      setRunDetail(null);
      setArtifacts([]);
      setRunTurns([]);
      setSessionRef(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [detail, artifactList, turnList] = await Promise.all([
        loopsApi.getRun(runId),
        loopsApi.listRunArtifacts(runId),
        loopsApi.listRunTurns(runId),
      ]);
      setRunDetail(detail);
      setArtifacts(artifactList.artifacts);
      setRunTurns(turnList.turns);
      setSessionRef((current) => current ?? detail.session_ref);
    } catch (err) {
      setRunDetail(null);
      setArtifacts([]);
      setRunTurns([]);
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unsubs = RUN_REFRESH_EVENTS.map((eventType) =>
      activityBus.on(eventType, (event) => {
        if (
          "loop_id" in event &&
          typeof event.loop_id === "string" &&
          loopId &&
          event.loop_id !== loopId
        ) {
          return;
        }
        if (
          "run_id" in event &&
          typeof event.run_id === "string" &&
          runId &&
          event.run_id !== runId
        ) {
          return;
        }
        if (
          (eventType === "turn-started" ||
            eventType === "verification-started" ||
            eventType === "verification-completed") &&
          "session_ref" in event &&
          typeof event.session_ref === "string"
        ) {
          setSessionRef(event.session_ref);
        }
        void refresh();
      }),
    );
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [loopId, refresh, runId]);

  return {
    runDetail,
    artifacts,
    runTurns,
    loading,
    error,
    sessionRef,
    refresh,
  };
}
