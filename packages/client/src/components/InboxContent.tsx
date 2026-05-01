import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { type InboxItem, useInboxContext } from "../contexts/InboxContext";
import { useDrafts } from "../hooks/useDrafts";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import type { Project } from "../types";
import { FilterDropdown, type FilterOption } from "./FilterDropdown";

function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

interface TierConfig {
  key: string;
  titleKey: string;
  layout: "list" | "grid";
}

const TIER_CONFIGS: TierConfig[] = [
  {
    key: "needsAttention",
    titleKey: "inboxTierNeedsAttention",
    layout: "list",
  },
  { key: "active", titleKey: "inboxTierActive", layout: "list" },
  {
    key: "recentActivity",
    titleKey: "inboxTierRecentActivity",
    layout: "grid",
  },
  { key: "unread8h", titleKey: "inboxTierUnread8h", layout: "grid" },
  { key: "unread24h", titleKey: "inboxTierUnread24h", layout: "grid" },
];

const TIER_ICONS: Record<string, { svg: React.ReactNode; colorClass: string }> =
  {
    needsAttention: {
      svg: (
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      ),
      colorClass: "text-[var(--attention-color)]",
    },
    active: {
      svg: (
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      ),
      colorClass: "text-[var(--thinking-color)]",
    },
    recentActivity: {
      svg: (
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      ),
      colorClass: "text-[var(--text-muted)]",
    },
    unread8h: {
      svg: (
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="12" r="3" fill="currentColor" />
        </svg>
      ),
      colorClass: "text-[var(--link-color)]",
    },
    unread24h: {
      svg: (
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="12" r="3" fill="currentColor" />
        </svg>
      ),
      colorClass: "text-[var(--text-dimmed)]",
    },
  };

function InboxSectionHeader({
  titleKey,
  tierKey,
  count,
}: {
  titleKey: string;
  tierKey: string;
  count: number;
}) {
  const { t } = useI18n();
  const tierIcon = TIER_ICONS[tierKey];

  return (
    <h2 className="flex items-center gap-2 text-2xl [font-family:var(--font-display)] text-[var(--text-primary)] m-0 mb-4">
      {tierIcon && (
        <span className={`shrink-0 ${tierIcon.colorClass}`}>
          {tierIcon.svg}
        </span>
      )}
      <span>{t(titleKey as never)}</span>
      <span className="[font-size:var(--font-size-xs)] font-medium px-2 py-0.5 rounded-full bg-[var(--bg-secondary)] text-[var(--text-muted)]">
        {count}
      </span>
    </h2>
  );
}

interface InboxCardProps {
  item: InboxItem;
  basePath: string;
  hasDraft: boolean;
  showArrow?: boolean;
}

function InboxCard({ item, basePath, hasDraft, showArrow }: InboxCardProps) {
  return (
    <Link
      to={`${basePath}/projects/${item.projectId}/sessions/${item.sessionId}`}
      className="flex flex-col rounded-lg border border-[var(--border-color)] bg-[var(--bg-surface)] p-6 no-underline transition-colors hover:border-[var(--border-subtle)]"
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          {item.projectName}
        </span>
        <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-dimmed)]">
          {formatRelativeTime(item.updatedAt)}
        </span>
      </div>
      <h3 className="text-xl [font-family:var(--font-display)] text-[var(--text-primary)] leading-snug mb-2">
        {item.sessionTitle || "Untitled session"}
      </h3>
      {item.sessionTitle && (
        <p className="text-sm text-[var(--text-muted)] leading-relaxed mb-3">
          {item.sessionTitle}
        </p>
      )}
      {hasDraft && (
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--accent-rust)] bg-[var(--accent-rust)]/10 px-2 py-0.5 rounded self-start">
          Draft
        </span>
      )}
      {showArrow && (
        <div className="mt-auto pt-2 flex justify-end">
          <span className="text-[var(--text-muted)]">→</span>
        </div>
      )}
    </Link>
  );
}

interface InboxSectionProps {
  config: TierConfig;
  items: InboxItem[];
  basePath?: string;
  drafts: Set<string>;
}

function InboxSection({
  config,
  items,
  basePath = "",
  drafts,
}: InboxSectionProps) {
  const { t } = useI18n();
  const isEmpty = items.length === 0;

  return (
    <section className={`mb-10 ${isEmpty ? "opacity-60" : ""}`}>
      <InboxSectionHeader
        titleKey={config.titleKey}
        tierKey={config.key}
        count={items.length}
      />
      {isEmpty ? (
        <p className="m-0 p-3 text-[var(--text-dimmed)] [font-size:var(--font-size-sm)] italic">
          {t("inboxNoSessions")}
        </p>
      ) : config.layout === "grid" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {items.map((item) => (
            <InboxCard
              key={item.sessionId}
              item={item}
              basePath={basePath}
              hasDraft={drafts.has(item.sessionId)}
              showArrow
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {items.map((item) => (
            <InboxCard
              key={item.sessionId}
              item={item}
              basePath={basePath}
              hasDraft={drafts.has(item.sessionId)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export interface InboxContentProps {
  /** Optional projectId to filter inbox to a single project */
  projectId?: string;
  /** List of projects for the filter dropdown */
  projects?: Project[];
  /** Callback when project filter changes */
  onProjectChange?: (projectId: string | undefined) => void;
}

/**
 * Filter inbox items by project ID.
 */
function filterByProject(
  items: InboxItem[],
  projectId: string | undefined,
): InboxItem[] {
  if (!projectId) return items;
  return items.filter((item) => item.projectId === projectId);
}

/**
 * Shared inbox content component.
 * Displays inbox tiers, refresh button, and empty/loading/error states.
 * Uses InboxContext for data - filtering is done client-side.
 */
export function InboxContent({
  projectId,
  projects,
  onProjectChange,
}: InboxContentProps) {
  const { t } = useI18n();
  const basePath = useRemoteBasePath();
  const navigate = useNavigate();
  const {
    needsAttention: allNeedsAttention,
    active: allActive,
    recentActivity: allRecentActivity,
    unread8h: allUnread8h,
    unread24h: allUnread24h,
    loading,
    error,
    refresh,
  } = useInboxContext();

  // Filter by project if specified
  const needsAttention = filterByProject(allNeedsAttention, projectId);
  const active = filterByProject(allActive, projectId);
  const recentActivity = filterByProject(allRecentActivity, projectId);
  const unread8h = filterByProject(allUnread8h, projectId);
  const unread24h = filterByProject(allUnread24h, projectId);

  const totalItems =
    needsAttention.length +
    active.length +
    recentActivity.length +
    unread8h.length +
    unread24h.length;

  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const handleRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  // Filter items by search query
  const filterBySearch = (items: InboxItem[]): InboxItem[] => {
    if (!searchQuery.trim()) return items;
    const q = searchQuery.trim().toLowerCase();
    return items.filter(
      (item) =>
        (item.sessionTitle ?? "").toLowerCase().includes(q) ||
        item.projectName.toLowerCase().includes(q),
    );
  };

  // Map tier keys to their data (with search filtering)
  const tierData = {
    needsAttention: filterBySearch(needsAttention),
    active: filterBySearch(active),
    recentActivity: filterBySearch(recentActivity),
    unread8h: filterBySearch(unread8h),
    unread24h: filterBySearch(unread24h),
  };

  const filteredTotal =
    tierData.needsAttention.length +
    tierData.active.length +
    tierData.recentActivity.length +
    tierData.unread8h.length +
    tierData.unread24h.length;

  const isEmpty = filteredTotal === 0 && !loading;

  // Track which sessions have unsent drafts
  const drafts = useDrafts();

  // Build project options for FilterDropdown
  const projectOptions: FilterOption<string>[] = projects
    ? [
        { value: "", label: t("inboxAllProjects") },
        ...projects.map((p) => ({ value: p.id, label: p.name })),
      ]
    : [];

  const handleProjectSelect = (selected: string[]) => {
    const value = selected[0] ?? "";
    onProjectChange?.(value === "" ? undefined : value);
  };

  return (
    <main className="flex-1 min-h-0 min-w-0 w-full overflow-x-hidden overflow-y-auto [-webkit-overflow-scrolling:touch]">
      <div className="box-border min-w-0 w-full max-w-[1200px] mx-auto px-6 py-8 md:px-10 md:py-10">
        {/* Toolbar with project filter, search, and refresh button */}
        <div className="flex flex-wrap items-center justify-between gap-2 mb-6">
          <div className="flex items-center gap-2">
            {projects && projects.length > 0 && (
              <FilterDropdown
                label={t("inboxFilterProject")}
                options={projectOptions}
                selected={[projectId ?? ""]}
                onChange={handleProjectSelect}
                multiSelect={false}
                placeholder={t("inboxAllProjects")}
              />
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="relative w-48 md:w-56">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                type="text"
                className="w-full rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)] py-2 pl-9 pr-4 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-dimmed)] focus:border-[var(--focus-border)]"
                placeholder={t("globalSessionsSearchPlaceholder")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="flex items-center gap-2 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-[var(--radius-md)] text-[var(--text-muted)] [font-size:var(--font-size-sm)] cursor-pointer hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] hover:border-[var(--text-muted)] disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleRefresh}
              disabled={refreshing || loading}
              title={t("inboxRefreshTitle")}
            >
              <span
                className={
                  refreshing ? "animate-spin inline-block" : "inline-block"
                }
              >
                &#x21bb;
              </span>
              {refreshing ? t("inboxRefreshing") : t("inboxRefresh")}
            </button>
          </div>
        </div>

        {loading && (
          <p className="p-3 [font-size:var(--font-size-sm)] italic text-[var(--text-muted)]">
            {t("inboxLoading")}
          </p>
        )}

        {error && (
          <p className="p-3 [font-size:var(--font-size-sm)] text-[var(--error-color)]">
            {t("inboxError", { message: error.message })}
          </p>
        )}

        {!loading && !error && isEmpty && (
          <div className="flex flex-col items-center justify-center py-16 px-4 text-center text-[var(--text-muted)]">
            <span className="text-5xl text-[var(--success-color)] mb-4">
              &#x2713;
            </span>
            <h3 className="m-0 mb-2 text-xl [font-family:var(--font-display)] text-[var(--text-primary)]">
              {t("inboxEmptyTitle")}
            </h3>
            <p className="m-0 [font-size:var(--font-size-base)]">
              {projectId
                ? t("inboxEmptyDescriptionProject")
                : t("inboxEmptyDescription")}
            </p>
          </div>
        )}

        {!loading && !error && !isEmpty && (
          <div className="flex flex-col gap-4">
            {TIER_CONFIGS.map((config) => (
              <InboxSection
                key={config.key}
                config={config}
                items={
                  (tierData as Record<string, InboxItem[]>)[config.key] ?? []
                }
                basePath={basePath}
                drafts={drafts}
              />
            ))}

            {/* View archived conversations */}
            <div className="flex justify-center pt-4">
              <button
                type="button"
                className="px-6 py-2.5 bg-transparent border border-[var(--border-color)] rounded-[var(--radius-md)] text-[var(--text-muted)] [font-size:var(--font-size-sm)] font-medium cursor-pointer hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] hover:border-[var(--text-muted)] transition-colors duration-150"
                onClick={() =>
                  navigate(`${basePath}/global-sessions?status=archived`)
                }
              >
                {t("inboxViewArchived")}
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
