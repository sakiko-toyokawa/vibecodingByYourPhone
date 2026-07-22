import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type LoopRunSummary, type StoredLoop, loopsApi } from "../api/loops";
import { PageHeader } from "../components/PageHeader";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";
import { runStateBadgeClass } from "../lib/loopStateStyle";

interface LoopListEntry {
  loop: StoredLoop;
  /** Latest run (runs are newest-first), undefined when never run or on error */
  lastRun?: LoopRunSummary;
}

function formatTrigger(loop: StoredLoop): string {
  const trigger = loop.card.loop.trigger;
  if (trigger.type === "schedule" && trigger.cron) {
    return trigger.cron;
  }
  return trigger.type;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

/**
 * Loops list page: registered loops with trigger type, latest run state,
 * and creation time. Click a loop to open its detail page.
 */
export function LoopsPage() {
  const { t } = useI18n();
  const { openSidebar, isWideScreen } = useNavigationLayout();
  const basePath = useRemoteBasePath();
  const [entries, setEntries] = useState<LoopListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    try {
      const { loops } = await loopsApi.listLoops();
      const visible = loops.filter((loop) => !loop.archived);
      // Latest run state per loop; a failing runs call must not hide the loop
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
      setEntries(withRuns);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div
      className={
        isWideScreen
          ? "flex min-h-0 min-w-0 flex-1 justify-center overflow-hidden"
          : "flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-x-hidden"
      }
    >
      <div
        className={
          isWideScreen
            ? "flex h-dvh w-full flex-col"
            : "flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-x-hidden"
        }
      >
        <PageHeader title={t("loopsTitle")} onOpenSidebar={openSidebar} />

        <main className="flex-1 min-h-0 min-w-0 w-full overflow-x-hidden overflow-y-auto [-webkit-overflow-scrolling:touch]">
          <div className="box-border min-w-0 w-full px-6 py-8 md:px-10 md:py-10">
            {loading && (
              <p className="p-3 [font-size:var(--font-size-sm)] italic text-[var(--text-muted)]">
                {t("loopsLoading")}
              </p>
            )}

            {error && (
              <p className="p-3 [font-size:var(--font-size-sm)] text-[var(--error-color)]">
                {t("loopsError", { message: error.message })}
              </p>
            )}

            {!loading && !error && entries.length === 0 && (
              <p className="p-[var(--space-3)] italic text-[var(--text-muted)]">
                {t("loopsEmpty")}
              </p>
            )}

            {!loading && !error && entries.length > 0 && (
              <div className="flex flex-col gap-[var(--space-2)]">
                {entries.map(({ loop, lastRun }) => (
                  <Link
                    key={loop.id}
                    to={`${basePath}/loops/${encodeURIComponent(loop.id)}`}
                    className="block w-full border border-[var(--border-color)] rounded-[var(--radius-md)] bg-[var(--bg-secondary)] p-6 text-left no-underline text-inherit transition-[border-color] duration-150 hover:border-[var(--border-hover)]"
                  >
                    <div className="flex flex-col gap-[var(--space-1)]">
                      <div className="flex min-w-0 items-center gap-[var(--space-2)]">
                        <span className="overflow-hidden text-ellipsis whitespace-nowrap font-medium text-[var(--text-primary)]">
                          {loop.id}
                        </span>
                        {lastRun && (
                          <span
                            className={`shrink-0 whitespace-nowrap rounded-[var(--radius-sm)] px-2 py-0.5 [font-size:var(--font-size-xs)] font-medium ${runStateBadgeClass(lastRun.state)}`}
                          >
                            {lastRun.state}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-[var(--space-3)] gap-y-1">
                        <span className="[font-size:var(--font-size-sm)] font-mono text-[var(--text-muted)]">
                          {formatTrigger(loop)}
                        </span>
                        <span className="[font-size:var(--font-size-sm)] text-[var(--text-muted)]">
                          {t("loopsCreated", {
                            time: formatTime(loop.created_at),
                          })}
                        </span>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
