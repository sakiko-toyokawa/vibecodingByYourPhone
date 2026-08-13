import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type HumanSlaItem, loopsApi } from "../api/loops";
import { PageHeader } from "../components/PageHeader";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";

function formatAge(iso: string): string {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 60_000),
  );
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (24 * 60))}d`;
}

function statusClass(state: string): string {
  if (state === "needs_human")
    return "bg-[var(--bg-warning)] text-[var(--color-warning)]";
  if (state === "budget_limited")
    return "bg-[var(--bg-error)] text-[var(--text-error)]";
  return "bg-[var(--bg-muted)] text-[var(--text-muted)]";
}

/**
 * Cross-loop human action queue with SLA deadlines. It is intentionally a
 * dense operations view: stale work first, then the oldest requests.
 */
export function HumanSlaQueuePage() {
  const basePath = useRemoteBasePath();
  const [items, setItems] = useState<HumanSlaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { items: next } = await loopsApi.listPendingHuman();
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
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="min-h-screen p-4 md:p-6">
      <PageHeader title="Human Action Queue" />
      {error && (
        <div className="mb-4 rounded-md border border-[var(--border-muted)] bg-[var(--bg-error)] px-3 py-2 text-sm text-[var(--text-error)]">
          {error}
        </div>
      )}
      {loading ? (
        <div className="text-sm text-[var(--text-muted)]">Loading...</div>
      ) : items.length === 0 ? (
        <div className="text-sm text-[var(--text-muted)]">
          No blocked runs are waiting for a human action.
        </div>
      ) : (
        <div className="grid gap-3">
          {items.map((item) => (
            <Link
              key={item.run_id}
              to={`${basePath}/loops/${encodeURIComponent(item.loop_id)}`}
              className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 no-underline transition-colors hover:bg-[var(--bg-hover)]"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded px-2 py-0.5 text-xs font-medium ${statusClass(item.state)}`}
                >
                  {item.state}
                </span>
                {item.abandon_due && (
                  <span className="rounded bg-[var(--bg-error)] px-2 py-0.5 text-xs text-[var(--text-error)]">
                    SLA expired
                  </span>
                )}
                {item.reminder_due && !item.abandon_due && (
                  <span className="rounded bg-[var(--bg-warning)] px-2 py-0.5 text-xs text-[var(--color-warning)]">
                    reminder due
                  </span>
                )}
                <span className="ml-auto text-xs text-[var(--text-muted)]">
                  {item.loop_id}
                </span>
              </div>
              <div className="mt-2 text-sm leading-5 text-[var(--text-primary)]">
                {item.reason}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-[var(--text-muted)] md:grid-cols-4">
                <div>waiting {formatAge(item.entered_at)}</div>
                <div>reminder {formatAge(item.reminder_at)}</div>
                <div>deadline {formatAge(item.abandon_at)}</div>
                <div>policy {item.policy}</div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
