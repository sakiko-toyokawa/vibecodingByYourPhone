import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  type GitHubRelation,
  type GitHubRelationState,
  githubApi,
} from "../../api/github";
import type { LoopListEntry } from "../../hooks/useLoops";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import { activityBus } from "../../lib/activityBus";
import { humanizeRelationState } from "../../lib/loopHumanText";
import { runStateBadgeClass } from "../../lib/loopStateStyle";

interface PipelineBoardProps {
  entries: LoopListEntry[];
}

const RELATION_REFRESH_EVENTS = [
  "relation-state-changed",
  "feedback-received",
] as const;

const COLUMNS: Array<{
  state: GitHubRelationState | "done";
  label: string;
}> = [
  { state: "pr_pending_approval", label: "Pending approval" },
  { state: "awaiting_review", label: "Awaiting review" },
  { state: "awaiting_feedback", label: "Awaiting feedback" },
  { state: "fixing", label: "Fixing" },
  { state: "needs_human", label: "Needs human" },
  { state: "done", label: "Done" },
];

function columnOf(relation: GitHubRelation): GitHubRelationState | "done" {
  if (relation.state === "merged" || relation.state === "closed") {
    return "done";
  }
  return relation.state;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function PipelineCard({
  relation,
  entry,
  basePath,
}: {
  relation: GitHubRelation;
  entry?: LoopListEntry;
  basePath: string;
}) {
  const runId =
    relation.pending_publish?.run_id ?? entry?.lastRun?.run_id ?? null;
  const target = runId
    ? `${basePath}/runs/${encodeURIComponent(runId)}`
    : `${basePath}/loops/${encodeURIComponent(relation.loop_id)}`;
  const pr = relation.subject.pr_number
    ? `#${relation.subject.pr_number}`
    : relation.subject.branch;

  return (
    <Link
      to={target}
      className="min-w-0 rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] p-3 no-underline transition-colors hover:border-[var(--border-hover)]"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-all font-mono text-xs font-semibold text-[var(--text-primary)]">
          {relation.subject.repository} {pr}
        </span>
        <span className="rounded-[var(--radius-sm)] bg-[var(--bg-hover)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
          {humanizeRelationState(relation.state)}
        </span>
      </div>
      {relation.pending_publish?.title && (
        <div className="mt-2 truncate text-sm text-[var(--text-secondary)]">
          {relation.pending_publish.title}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
        <span>repair {relation.repair_count}</span>
        {entry?.lastRun && (
          <span
            className={`rounded-[var(--radius-sm)] px-2 py-0.5 font-medium ${runStateBadgeClass(entry.lastRun.state)}`}
          >
            {entry.lastRun.state}
          </span>
        )}
        <span className="ml-auto">{formatTime(relation.updated_at)}</span>
      </div>
    </Link>
  );
}

/**
 * Pipeline board groups GitHub relations by their current state and leaves
 * standalone loops in a final column. Relation events move cards between
 * columns without a manual refresh.
 */
export function PipelineBoard({ entries }: PipelineBoardProps) {
  const basePath = useRemoteBasePath();
  const [relations, setRelations] = useState<GitHubRelation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadRelations = useCallback(async () => {
    try {
      const { relations: next } = await githubApi.listRelations();
      setRelations(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRelations();
    const unsubs = RELATION_REFRESH_EVENTS.map((eventType) =>
      activityBus.on(eventType, () => void loadRelations()),
    );
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [loadRelations]);

  const entriesByLoop = useMemo(
    () => new Map(entries.map((entry) => [entry.loop.id, entry])),
    [entries],
  );
  const relationLoopIds = useMemo(
    () => new Set(relations.map((relation) => relation.loop_id)),
    [relations],
  );
  const standalone = useMemo(
    () => entries.filter((entry) => !relationLoopIds.has(entry.loop.id)),
    [entries, relationLoopIds],
  );

  if (error && relations.length === 0) {
    return (
      <section className="rounded-[var(--radius-md)] border border-[var(--error-color)]/40 bg-[var(--error-color)]/10 p-4 text-sm text-[var(--error-color)]">
        {error}
      </section>
    );
  }

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 text-sm font-semibold text-[var(--text-primary)]">
          Pipeline
        </h2>
        <span className="rounded-[var(--radius-sm)] bg-[var(--bg-hover)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
          {relations.length} relations
        </span>
      </div>

      {loading && relations.length === 0 ? (
        <p className="text-xs italic text-[var(--text-muted)]">
          Loading relations…
        </p>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-3 md:flex md:max-w-full md:items-start md:gap-3 md:overflow-x-auto">
          {COLUMNS.map((column) => {
            const columnRelations = relations.filter(
              (relation) => columnOf(relation) === column.state,
            );
            return (
              <div
                key={column.state}
                className="min-w-0 rounded-[var(--radius-md)] border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 md:w-[280px] md:shrink-0"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="m-0 text-xs font-semibold text-[var(--text-muted)]">
                    {column.label}
                  </h3>
                  <span className="rounded-[var(--radius-sm)] bg-[var(--bg-hover)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
                    {columnRelations.length}
                  </span>
                </div>
                <div className="grid gap-2">
                  {columnRelations.length === 0 ? (
                    <p className="text-xs italic text-[var(--text-dimmed)]">
                      Empty
                    </p>
                  ) : (
                    columnRelations.map((relation) => (
                      <PipelineCard
                        key={relation.relation_id}
                        relation={relation}
                        entry={entriesByLoop.get(relation.loop_id)}
                        basePath={basePath}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}

          <div className="min-w-0 rounded-[var(--radius-md)] border border-dashed border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 md:w-[280px] md:shrink-0">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="m-0 text-xs font-semibold text-[var(--text-muted)]">
                Standalone
              </h3>
              <span className="rounded-[var(--radius-sm)] bg-[var(--bg-hover)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
                {standalone.length}
              </span>
            </div>
            <div className="grid gap-2">
              {standalone.length === 0 ? (
                <p className="text-xs italic text-[var(--text-dimmed)]">
                  Empty
                </p>
              ) : (
                standalone.map((entry) => (
                  <Link
                    key={entry.loop.id}
                    to={`${basePath}/loops/${encodeURIComponent(entry.loop.id)}`}
                    className="min-w-0 rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] p-3 no-underline transition-colors hover:border-[var(--border-hover)]"
                  >
                    <div className="break-all text-sm font-medium text-[var(--text-primary)]">
                      {entry.loop.id}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                      <span>
                        {entry.loop.card.loop.trigger.type} ·{" "}
                        {entry.loop.card.loop.verification.required.join("/")}
                      </span>
                      {entry.lastRun && (
                        <span
                          className={`rounded-[var(--radius-sm)] px-2 py-0.5 font-medium ${runStateBadgeClass(entry.lastRun.state)}`}
                        >
                          {entry.lastRun.state}
                        </span>
                      )}
                    </div>
                  </Link>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
