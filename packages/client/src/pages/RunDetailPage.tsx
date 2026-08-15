import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { loopsApi } from "../api/loops";
import { LoopDetailPage } from "./LoopDetailPage";

/** Directly addressable run detail route backed by the loop detail view. */
export function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const [loopId, setLoopId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    loopsApi
      .getRun(runId)
      .then((detail) => {
        if (!cancelled) setLoopId(detail.run.loop_id);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (error) {
    return (
      <div className="p-6 text-sm text-[var(--error-color)]">
        Run not found: {error}
      </div>
    );
  }
  if (!loopId) {
    return (
      <div className="p-6 text-sm italic text-[var(--text-muted)]">
        Loading run…
      </div>
    );
  }
  return <LoopDetailPage initialLoopId={loopId} initialRunId={runId} />;
}
