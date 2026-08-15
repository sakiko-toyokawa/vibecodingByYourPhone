import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { LoopListEntry } from "../../hooks/useLoops";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import { activityBus } from "../../lib/activityBus";

type RunPhase = "executing" | "verifying" | "waiting";

interface ActiveRun {
  runId: string;
  loopId: string;
  turn: number;
  phase: RunPhase;
  startedAt: string;
  updatedAt: string;
}

function isTerminalRunState(state: string | undefined): boolean {
  return (
    state === "complete" ||
    state === "failed" ||
    state === "discarded" ||
    state === "budget_limited"
  );
}

function phaseLabel(phase: RunPhase): string {
  switch (phase) {
    case "executing":
      return "executing";
    case "verifying":
      return "verifying";
    case "waiting":
      return "waiting";
  }
}

/**
 * In-memory active run strip. Lifecycle events update turn and phase; the
 * loop list seeds it so a page refresh while a run is active still works.
 */
export function ActiveRunsBar({ entries }: { entries: LoopListEntry[] }) {
  const basePath = useRemoteBasePath();
  const [runs, setRuns] = useState<Record<string, ActiveRun>>({});
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setRuns((current) => {
      const next = { ...current };
      for (const entry of entries) {
        const run = entry.lastRun;
        if (!run || (run.state !== "active" && run.state !== "retry")) continue;
        if (next[run.run_id]) continue;
        next[run.run_id] = {
          runId: run.run_id,
          loopId: run.loop_id,
          turn: 1,
          phase: "executing",
          startedAt: run.created_at,
          updatedAt: run.created_at,
        };
      }
      return next;
    });
  }, [entries]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const unsubs = [
      activityBus.on("run-started", (event) => {
        setRuns((current) => ({
          ...current,
          [event.run_id]: {
            runId: event.run_id,
            loopId: event.loop_id,
            turn: 1,
            phase: "executing",
            startedAt: event.timestamp,
            updatedAt: event.timestamp,
          },
        }));
      }),
      activityBus.on("turn-started", (event) => {
        setRuns((current) => {
          const existing = current[event.run_id];
          if (!existing) return current;
          return {
            ...current,
            [event.run_id]: {
              ...existing,
              turn: event.turn,
              phase: "executing",
              updatedAt: event.timestamp,
            },
          };
        });
      }),
      activityBus.on("turn-completed", (event) => {
        setRuns((current) => {
          const existing = current[event.run_id];
          if (!existing) return current;
          return {
            ...current,
            [event.run_id]: {
              ...existing,
              phase: "waiting",
              updatedAt: event.timestamp,
            },
          };
        });
      }),
      activityBus.on("verification-started", (event) => {
        setRuns((current) => {
          const existing = current[event.run_id];
          if (!existing) return current;
          return {
            ...current,
            [event.run_id]: {
              ...existing,
              phase: "verifying",
              updatedAt: event.timestamp,
            },
          };
        });
      }),
      activityBus.on("verification-completed", (event) => {
        setRuns((current) => {
          const existing = current[event.run_id];
          if (!existing) return current;
          return {
            ...current,
            [event.run_id]: {
              ...existing,
              phase: "waiting",
              updatedAt: event.timestamp,
            },
          };
        });
      }),
      activityBus.on("run-decision-required", (event) => {
        setRuns((current) => {
          const existing = current[event.run_id];
          if (!existing) return current;
          return {
            ...current,
            [event.run_id]: {
              ...existing,
              phase: "waiting",
              updatedAt: event.timestamp,
            },
          };
        });
      }),
      activityBus.on("loop-state-changed", (event) => {
        const state = event.to_state ?? event.state;
        setRuns((current) => {
          const existing = current[event.run_id];
          if (!existing) return current;
          if (isTerminalRunState(state)) {
            const next = { ...current };
            delete next[event.run_id];
            return next;
          }
          return {
            ...current,
            [event.run_id]: {
              ...existing,
              phase: "waiting",
              updatedAt: event.timestamp,
            },
          };
        });
      }),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, []);

  const sorted = useMemo(
    () =>
      Object.values(runs).sort((a, b) =>
        a.updatedAt.localeCompare(b.updatedAt),
      ),
    [runs],
  );

  if (sorted.length === 0) return null;

  return (
    <section className="rounded-[var(--radius-md)] border border-[var(--border-color)] bg-[var(--bg-surface)] p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="m-0 text-sm font-semibold text-[var(--text-primary)]">
          Active Runs
        </h2>
        <span className="rounded-[var(--radius-sm)] bg-[var(--bg-hover)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
          {sorted.length} running
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {sorted.map((run) => {
          const elapsedSeconds = Math.max(
            0,
            Math.floor((now - new Date(run.startedAt).getTime()) / 1000),
          );
          const minutes = Math.floor(elapsedSeconds / 60);
          const seconds = elapsedSeconds % 60;
          return (
            <Link
              key={run.runId}
              to={`${basePath}/runs/${encodeURIComponent(run.runId)}`}
              className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 no-underline transition-colors hover:border-[var(--border-hover)]"
            >
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-[var(--accent-rust)]" />
                <span className="font-mono text-xs font-medium text-[var(--text-primary)]">
                  {run.runId}
                </span>
              </div>
              <div className="mt-1 text-xs text-[var(--text-muted)]">
                turn {run.turn} · {phaseLabel(run.phase)} · {minutes}m{" "}
                {seconds.toString().padStart(2, "0")}s
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
