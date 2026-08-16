import { useCallback, useEffect, useRef, useState } from "react";
import { loopsApi } from "../api/loops";
import { useSessionStream } from "../hooks/useSessionStream";
import {
  type DisplayEntry,
  MAX_DISPLAY_ENTRIES,
  type RuntimeEvent,
  buildDisplayEntries,
  parseRuntimeEvents,
  turnOfEventFile,
} from "./RunStreamOutput.shared.js";

interface RunStreamOutputProps {
  runId: string;
  isActive: boolean;
  sessionRef: string | null;
}

function kindLabel(kind: DisplayEntry["kind"]): string {
  switch (kind) {
    case "system":
      return "[system]";
    case "user":
      return "[user]";
    case "assistant":
      return "[assistant]";
    case "error":
      return "[error]";
    case "result":
      return "[result]";
    case "info":
      return "[info]";
    case "tool_use":
      return "[tool_use]";
    case "tool_result":
      return "[tool_result]";
  }
}

/**
 * Live stream output for a loop run.
 * - History: reads every runtime-events[-turnN].jsonl artifact (one per
 *   completed turn, concatenated in turn order; each file is fetched once —
 *   completed turns are immutable).
 * - Active runs: also subscribes to the executor session via WebSocket for
 *   real-time messages, merging stream deltas into readable entries.
 *
 * Render with `key={runId}` so switching runs remounts with fresh state.
 */
export function RunStreamOutput({
  runId,
  isActive,
  sessionRef,
}: RunStreamOutputProps) {
  /** file name -> parsed events (completed-turn files never change) */
  const [eventsByFile, setEventsByFile] = useState<
    Record<string, RuntimeEvent[]>
  >({});
  const [liveEvents, setLiveEvents] = useState<RuntimeEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadedFilesRef = useRef<Set<string>>(new Set());

  const loadHistorical = useCallback(async () => {
    try {
      const { artifacts } = await loopsApi.listRunArtifacts(runId);
      const eventFiles = artifacts
        .filter((name) => turnOfEventFile(name) !== Number.POSITIVE_INFINITY)
        .sort((a, b) => turnOfEventFile(a) - turnOfEventFile(b));
      for (const name of eventFiles) {
        if (loadedFilesRef.current.has(name)) continue;
        try {
          const { content } = await loopsApi.getRunArtifact(runId, name);
          loadedFilesRef.current.add(name);
          const events = parseRuntimeEvents(content);
          setEventsByFile((prev) => ({ ...prev, [name]: events }));
        } catch {
          // A turn's file may vanish mid-listing; retry next poll.
        }
      }
      setError(null);
    } catch {
      setError("runtime events not available yet");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void loadHistorical();
    if (!isActive) return;
    const interval = setInterval(() => void loadHistorical(), 5000);
    return () => clearInterval(interval);
  }, [loadHistorical, isActive]);

  const handleStreamMessage = useCallback(
    (data: { eventType: string; [key: string]: unknown }) => {
      if (data.eventType !== "message") return;
      setLiveEvents((prev) => [
        ...prev,
        {
          at: new Date().toISOString(),
          message: data as RuntimeEvent["message"],
        },
      ]);
    },
    [],
  );

  const { connected: wsConnected } = useSessionStream(
    isActive && sessionRef ? sessionRef : null,
    { onMessage: handleStreamMessage },
  );

  // Completed turns are merged per file; a divider marks each turn when the
  // run has more than one, so turn 1 / turn 2 stay distinguishable.
  const turnGroups = Object.keys(eventsByFile)
    .sort((a, b) => turnOfEventFile(a) - turnOfEventFile(b))
    .map((name) => ({
      turn: turnOfEventFile(name),
      entries: buildDisplayEntries(eventsByFile[name] ?? []),
    }))
    .filter((group) => group.entries.length > 0);

  const allEntries: DisplayEntry[] = [];
  for (const group of turnGroups) {
    if (turnGroups.length > 1) {
      allEntries.push({
        at: group.entries[0]?.at ?? "",
        kind: "info",
        text: `—— turn ${group.turn} ——`,
      });
    }
    allEntries.push(...group.entries);
  }
  allEntries.push(...buildDisplayEntries(liveEvents));
  const displayEntries = allEntries.slice(-MAX_DISPLAY_ENTRIES);
  const hiddenCount = allEntries.length - displayEntries.length;

  if (loading) {
    return (
      <p className="p-3 [font-size:var(--font-size-sm)] italic text-[var(--text-muted)]">
        Loading stream…
      </p>
    );
  }

  if (allEntries.length === 0) {
    return (
      <p className="p-3 [font-size:var(--font-size-sm)] italic text-[var(--text-muted)]">
        {isActive
          ? "Waiting for executor output…"
          : "No stream events recorded."}
      </p>
    );
  }

  return (
    <div className="flex max-h-[480px] flex-col gap-2 overflow-y-auto rounded bg-[var(--bg-primary)] p-3">
      {hiddenCount > 0 && (
        <div className="[font-size:var(--font-size-xs)] italic text-[var(--text-dimmed)]">
          … {hiddenCount} earlier entries hidden (showing latest{" "}
          {displayEntries.length}) …
        </div>
      )}
      {displayEntries.map((entry, index) => (
        <div key={`${entry.at}-${index}`} className="flex gap-2">
          <span className="shrink-0 font-mono [font-size:var(--font-size-xs)] text-[var(--text-dimmed)]">
            {new Date(entry.at).toLocaleTimeString()}
          </span>
          <span
            className={`shrink-0 font-mono [font-size:var(--font-size-xs)] ${
              entry.kind === "error"
                ? "text-[var(--error-color)]"
                : entry.kind === "assistant"
                  ? "text-[var(--accent-rust)]"
                  : entry.kind === "tool_use" || entry.kind === "tool_result"
                    ? "text-[var(--accent-rust)]"
                    : "text-[var(--text-muted)]"
            }`}
          >
            {entry.label ?? kindLabel(entry.kind)}
          </span>
          <span className="min-w-0 flex-1">
            {entry.kind === "tool_result" ? (
              <details className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] p-2">
                <summary className="cursor-pointer text-xs font-medium text-[var(--text-secondary)]">
                  Show result
                </summary>
                <div className="mt-2 whitespace-pre-wrap break-all [font-size:var(--font-size-sm)] text-[var(--text-primary)]">
                  {entry.text}
                </div>
              </details>
            ) : (
              <span className="whitespace-pre-wrap break-all [font-size:var(--font-size-sm)] text-[var(--text-primary)]">
                {entry.text}
              </span>
            )}
          </span>
        </div>
      ))}
      {isActive && (
        <div className="mt-2 [font-size:var(--font-size-xs)] italic text-[var(--text-muted)]">
          {wsConnected ? "live" : "polling"}…
        </div>
      )}
    </div>
  );
}
