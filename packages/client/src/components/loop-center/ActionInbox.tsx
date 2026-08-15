import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { type GitHubRelation, githubApi } from "../../api/github";
import { type HumanSlaItem, loopsApi } from "../../api/loops";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import { activityBus } from "../../lib/activityBus";
import { humanizeRelationState } from "../../lib/loopHumanText";

type InboxKind = "sla" | "needs_human" | "relation";

interface InboxItem {
  id: string;
  kind: InboxKind;
  urgency: number;
  title: string;
  subtitle: string;
  loopId: string;
  runId?: string;
  relation?: GitHubRelation;
  human?: HumanSlaItem;
  timestamp: string;
}

const REFRESH_EVENTS = [
  "run-decision-required",
  "loop-state-changed",
  "relation-state-changed",
  "feedback-received",
] as const;

function urgencyForHuman(item: HumanSlaItem): number {
  if (item.abandon_due) return 0;
  if (item.state === "needs_human") return 1;
  return 2;
}

function humanToItem(item: HumanSlaItem): InboxItem {
  const kind: InboxKind = item.abandon_due ? "sla" : "needs_human";
  return {
    id: `run:${item.run_id}`,
    kind,
    urgency: urgencyForHuman(item),
    title: item.reason,
    subtitle: `${item.loop_id} · ${item.state}`,
    loopId: item.loop_id,
    runId: item.run_id,
    human: item,
    timestamp: item.entered_at,
  };
}

function relationToItem(relation: GitHubRelation): InboxItem {
  const pr = relation.subject.pr_number
    ? `#${relation.subject.pr_number}`
    : relation.subject.branch;
  return {
    id: `relation:${relation.relation_id}`,
    kind: "relation",
    urgency: 1,
    title: `${relation.subject.repository} ${pr}`,
    subtitle: humanizeRelationState(relation.state),
    loopId: relation.loop_id,
    runId: relation.pending_publish?.run_id,
    relation,
    timestamp: relation.updated_at,
  };
}

function kindLabel(kind: InboxKind): string {
  switch (kind) {
    case "sla":
      return "SLA action";
    case "needs_human":
      return "Needs human";
    case "relation":
      return "PR approval";
  }
}

function kindClass(kind: InboxKind): string {
  switch (kind) {
    case "sla":
      return "bg-[var(--error-color)]/15 text-[var(--error-color)]";
    case "needs_human":
      return "bg-[var(--warning-color)]/15 text-[var(--warning-color)]";
    case "relation":
      return "bg-[var(--accent-rust)]/15 text-[var(--accent-rust)]";
  }
}

/**
 * Cross-loop action inbox for the Loop Center. It merges human-decision runs,
 * overdue SLA items, and pending PR approvals into one urgency-sorted list.
 */
export function ActionInbox() {
  const basePath = useRemoteBasePath();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const [pending, relations] = await Promise.all([
        loopsApi.listPendingHuman(),
        githubApi.listRelations().catch(() => ({ relations: [] })),
      ]);
      const next = [
        ...pending.items.map(humanToItem),
        ...relations.relations
          .filter((relation) => relation.state === "pr_pending_approval")
          .map(relationToItem),
      ].sort(
        (a, b) =>
          a.urgency - b.urgency || a.timestamp.localeCompare(b.timestamp),
      );
      setItems(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const unsubs = REFRESH_EVENTS.map((eventType) =>
      activityBus.on(eventType, () => void load()),
    );
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [load]);

  const runAction = useCallback(
    async (item: InboxItem, action: "approve" | "discard") => {
      setBusy((current) => new Set(current).add(item.id));
      setError(null);
      try {
        if (item.relation) {
          await githubApi.approvePr(item.relation.relation_id);
        } else if (item.runId) {
          if (action === "approve") {
            await loopsApi.submitDecision(item.runId, "approve");
          } else {
            await loopsApi.discardRun(item.runId, {
              reason: "Discarded from Loop Center",
              revert_files: false,
              cleanup_worktree: true,
              force: false,
            });
          }
        }
        await load();
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 409) {
          await load();
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setBusy((current) => {
          const next = new Set(current);
          next.delete(item.id);
          return next;
        });
      }
    },
    [load],
  );

  const visible = useMemo(
    () => items.filter((item) => !busy.has(item.id)),
    [busy, items],
  );

  return (
    <section className="rounded-[var(--radius-md)] border border-[var(--border-color)] bg-[var(--bg-surface)] p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="m-0 text-sm font-semibold text-[var(--text-primary)]">
          Action Inbox
        </h2>
        <span className="rounded-[var(--radius-sm)] bg-[var(--bg-hover)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
          {visible.length} waiting
        </span>
      </div>

      {error && (
        <p className="mb-3 rounded-[var(--radius-sm)] border border-[var(--error-color)]/40 bg-[var(--error-color)]/10 p-2 text-xs text-[var(--error-color)]">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-xs italic text-[var(--text-muted)]">
          Loading actions…
        </p>
      ) : visible.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">
          Nothing waiting for a human action.
        </p>
      ) : (
        <div className="grid gap-2">
          {visible.map((item) => {
            const target = item.runId
              ? `${basePath}/runs/${encodeURIComponent(item.runId)}`
              : `${basePath}/loops/${encodeURIComponent(item.loopId)}`;
            const isBusy = busy.has(item.id);
            return (
              <div
                key={item.id}
                className="flex flex-col gap-3 rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 sm:flex-row sm:items-center"
              >
                <Link to={target} className="min-w-0 flex-1 no-underline">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-[var(--radius-sm)] px-2 py-0.5 text-xs font-medium ${kindClass(item.kind)}`}
                    >
                      {kindLabel(item.kind)}
                    </span>
                    <span className="text-xs text-[var(--text-muted)]">
                      {new Date(item.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <div className="mt-1 break-words text-sm text-[var(--text-primary)]">
                    {item.title}
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-[var(--text-dimmed)]">
                    {item.subtitle}
                  </div>
                </Link>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {item.relation ? (
                    <>
                      <button
                        type="button"
                        className="rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--on-primary)] transition-opacity hover:opacity-90 disabled:opacity-50"
                        disabled={isBusy}
                        onClick={() => void runAction(item, "approve")}
                      >
                        {isBusy ? "Publishing..." : "Approve & Publish"}
                      </button>
                      <a
                        href={
                          item.relation.subject.pr_number
                            ? `https://github.com/${item.relation.subject.repository}/pull/${item.relation.subject.pr_number}`
                            : undefined
                        }
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-md border border-[var(--border-color)] bg-[var(--bg-hover)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)]"
                      >
                        Open PR
                      </a>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--on-primary)] transition-opacity hover:opacity-90 disabled:opacity-50"
                        disabled={isBusy}
                        onClick={() => void runAction(item, "approve")}
                      >
                        {isBusy ? "Approving..." : "Approve"}
                      </button>
                      <button
                        type="button"
                        className="rounded-md border border-[var(--error-color)]/40 bg-[var(--error-color)]/10 px-3 py-1.5 text-xs font-medium text-[var(--error-color)] transition-opacity hover:opacity-80 disabled:opacity-50"
                        disabled={isBusy}
                        onClick={() => void runAction(item, "discard")}
                      >
                        Discard
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
