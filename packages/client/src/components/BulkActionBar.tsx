import { useI18n } from "../i18n";

interface BulkActionBarProps {
  selectedCount: number;
  onArchive: () => Promise<void>;
  onUnarchive: () => Promise<void>;
  onStar: () => Promise<void>;
  onUnstar: () => Promise<void>;
  onMarkRead: () => Promise<void>;
  onMarkUnread: () => Promise<void>;
  onClearSelection: () => void;
  isPending?: boolean;
  /** True if any selected item can be archived (is not archived) */
  canArchive?: boolean;
  /** True if any selected item can be unarchived (is archived) */
  canUnarchive?: boolean;
  /** True if any selected item can be starred (is not starred) */
  canStar?: boolean;
  /** True if any selected item can be unstarred (is starred) */
  canUnstar?: boolean;
  /** True if any selected item can be marked as read (has unread) */
  canMarkRead?: boolean;
  /** True if any selected item can be marked as unread (is read) */
  canMarkUnread?: boolean;
  /** Archive all filtered sessions (shown when filters active, no selection) */
  onArchiveAllFiltered?: () => Promise<void>;
  /** Number of archivable sessions in filtered results */
  archivableFilteredCount?: number;
}

/**
 * Fixed bottom bar for bulk session actions.
 * Slides up when sessions are selected, slides down when cleared.
 */
export function BulkActionBar({
  selectedCount,
  onArchive,
  onUnarchive,
  onStar,
  onUnstar,
  onMarkRead,
  onMarkUnread,
  onClearSelection,
  isPending = false,
  canArchive = true,
  canUnarchive = true,
  canStar = true,
  canUnstar = true,
  canMarkRead = true,
  canMarkUnread = true,
  onArchiveAllFiltered,
  archivableFilteredCount = 0,
}: BulkActionBarProps) {
  const { t } = useI18n();
  // Show "Archive all N" bar when filters are active but no manual selection
  if (selectedCount === 0) {
    if (!onArchiveAllFiltered || archivableFilteredCount === 0) {
      return null;
    }

    return (
      <div className="fixed bottom-0 left-0 right-0 z-[100] flex items-center justify-between px-4 py-3 pb-[max(var(--space-3),env(safe-area-inset-bottom,0px))] bg-[var(--bg-surface)] border-t border-[var(--border-color)] shadow-[0_-2px_8px_rgba(0,0,0,0.08)]">
        <div className="flex gap-2">
          <button
            type="button"
            className="flex items-center gap-1 px-3 py-2 bg-[var(--text-primary)] text-white border border-[var(--text-primary)] rounded-[var(--radius-md)] [font-size:var(--font-size-sm)] font-semibold cursor-pointer hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed max-sm:flex-col"
            onClick={onArchiveAllFiltered}
            disabled={isPending}
            title={t("bulkArchiveAllFilteredTitle", {
              count: archivableFilteredCount,
            })}
          >
            <span className="text-sm">&#x1f4c1;</span>
            <span className="max-sm:[font-size:var(--font-size-xs)]">
              {t("bulkArchiveAll", { count: archivableFilteredCount })}
            </span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-[100] flex items-center justify-between px-4 py-3 pb-[max(var(--space-3),env(safe-area-inset-bottom,0px))] bg-[var(--bg-surface)] border-t border-[var(--border-color)] shadow-[0_-2px_8px_rgba(0,0,0,0.08)]">
      <div className="flex items-center gap-2">
        <span className="[font-size:var(--font-size-sm)] font-semibold text-[var(--text-primary)]">
          {t("bulkSelectedCount", { count: selectedCount })}
        </span>
        <button
          type="button"
          className="flex items-center justify-center w-7 h-7 p-0 bg-transparent border-none rounded-[var(--radius-sm)] text-[var(--text-muted)] cursor-pointer hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onClearSelection}
          disabled={isPending}
          aria-label={t("bulkClearSelection")}
        >
          <span className="text-sm">&#x2715;</span>
        </button>
      </div>

      <div className="flex gap-2 max-sm:gap-1">
        {canArchive && (
          <button
            type="button"
            className="flex items-center gap-1 px-3 py-2 bg-[var(--bg-hover)] border border-[var(--border-color)] rounded-[var(--radius-md)] text-[var(--text-primary)] [font-size:var(--font-size-sm)] cursor-pointer hover:bg-[var(--bg-surface)] hover:border-[var(--text-muted)] disabled:opacity-50 disabled:cursor-not-allowed max-sm:flex-col"
            onClick={onArchive}
            disabled={isPending}
            title={t("bulkArchiveSelected")}
          >
            <span className="text-sm">&#x1f4c1;</span>
            <span className="max-sm:[font-size:var(--font-size-xs)]">
              {t("bulkArchive")}
            </span>
          </button>
        )}

        {canUnarchive && (
          <button
            type="button"
            className="flex items-center gap-1 px-3 py-2 bg-[var(--bg-hover)] border border-[var(--border-color)] rounded-[var(--radius-md)] text-[var(--text-primary)] [font-size:var(--font-size-sm)] cursor-pointer hover:bg-[var(--bg-surface)] hover:border-[var(--text-muted)] disabled:opacity-50 disabled:cursor-not-allowed max-sm:flex-col"
            onClick={onUnarchive}
            disabled={isPending}
            title={t("bulkUnarchiveSelected")}
          >
            <span className="text-sm">&#x1f4c2;</span>
            <span className="max-sm:[font-size:var(--font-size-xs)]">
              {t("bulkUnarchive")}
            </span>
          </button>
        )}

        {canStar && (
          <button
            type="button"
            className="flex items-center gap-1 px-3 py-2 bg-[var(--bg-hover)] border border-[var(--border-color)] rounded-[var(--radius-md)] text-[var(--text-primary)] [font-size:var(--font-size-sm)] cursor-pointer hover:bg-[var(--bg-surface)] hover:border-[var(--text-muted)] disabled:opacity-50 disabled:cursor-not-allowed max-sm:flex-col"
            onClick={onStar}
            disabled={isPending}
            title={t("bulkStarSelected")}
          >
            <span className="text-sm">&#x2605;</span>
            <span className="max-sm:[font-size:var(--font-size-xs)]">
              {t("bulkStar")}
            </span>
          </button>
        )}

        {canUnstar && (
          <button
            type="button"
            className="flex items-center gap-1 px-3 py-2 bg-[var(--bg-hover)] border border-[var(--border-color)] rounded-[var(--radius-md)] text-[var(--text-primary)] [font-size:var(--font-size-sm)] cursor-pointer hover:bg-[var(--bg-surface)] hover:border-[var(--text-muted)] disabled:opacity-50 disabled:cursor-not-allowed max-sm:flex-col"
            onClick={onUnstar}
            disabled={isPending}
            title={t("bulkUnstarSelected")}
          >
            <span className="text-sm">&#x2606;</span>
            <span className="max-sm:[font-size:var(--font-size-xs)]">
              {t("bulkUnstar")}
            </span>
          </button>
        )}

        {canMarkRead && (
          <button
            type="button"
            className="flex items-center gap-1 px-3 py-2 bg-[var(--bg-hover)] border border-[var(--border-color)] rounded-[var(--radius-md)] text-[var(--text-primary)] [font-size:var(--font-size-sm)] cursor-pointer hover:bg-[var(--bg-surface)] hover:border-[var(--text-muted)] disabled:opacity-50 disabled:cursor-not-allowed max-sm:flex-col"
            onClick={onMarkRead}
            disabled={isPending}
            title={t("bulkMarkReadTitle")}
          >
            <span className="text-sm">&#x2713;</span>
            <span className="max-sm:[font-size:var(--font-size-xs)]">
              {t("bulkMarkRead")}
            </span>
          </button>
        )}

        {canMarkUnread && (
          <button
            type="button"
            className="flex items-center gap-1 px-3 py-2 bg-[var(--bg-hover)] border border-[var(--border-color)] rounded-[var(--radius-md)] text-[var(--text-primary)] [font-size:var(--font-size-sm)] cursor-pointer hover:bg-[var(--bg-surface)] hover:border-[var(--text-muted)] disabled:opacity-50 disabled:cursor-not-allowed max-sm:flex-col"
            onClick={onMarkUnread}
            disabled={isPending}
            title={t("bulkMarkUnreadTitle")}
          >
            <span className="text-sm">&#x25cf;</span>
            <span className="max-sm:[font-size:var(--font-size-xs)]">
              {t("bulkMarkUnread")}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
