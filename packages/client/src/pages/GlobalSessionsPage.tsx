import { ALL_PROVIDERS, type ProviderName } from "@yep-anywhere/shared";
import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { GlobalSessionItem } from "../api/client";
import {
  FilterDropdown,
  type FilterOption,
} from "../components/FilterDropdown";
import { PageHeader } from "../components/PageHeader";
import { SessionListItem } from "../components/SessionListItem";
import { useDrafts } from "../hooks/useDrafts";
import { useGlobalSessions } from "../hooks/useGlobalSessions";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";
import { getSessionDisplayTitle } from "../utils";

// Status filter options
type StatusFilter = "all" | "unread" | "starred" | "archived";

// Age filter options (days)
type AgeFilter = "3" | "7" | "14" | "30";

// Provider colors for filter dropdown (matching ProviderBadge)
const PROVIDER_COLORS: Record<ProviderName, string> = {
  claude: "var(--accent-rust)",
  "claude-ollama": "var(--accent-rust)", // Same as Claude
  codex: "#10a37f",
  "codex-oss": "#f97316",
  gemini: "#4285f4",
  "gemini-acp": "#4285f4", // Same as gemini
  opencode: "#9333ea", // Purple for OpenCode
};

/**
 * Global sessions page showing all sessions across all projects.
 * Supports filtering by project, status, provider, and search query.
 */
export function GlobalSessionsPage() {
  const { t } = useI18n();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const basePath = useRemoteBasePath();
  const [searchParams, setSearchParams] = useSearchParams();

  // Get filter params from URL
  const searchQuery = searchParams.get("q") || "";
  const projectFilter = searchParams.get("project") || undefined;

  // Local state for search input (instant feedback)
  const [searchInput, setSearchInput] = useState(searchQuery);

  // Status and provider filters from URL
  const statusFilters = useMemo(() => {
    const param = searchParams.get("status");
    if (!param) return [];
    return param
      .split(",")
      .filter((s): s is StatusFilter =>
        ["all", "unread", "starred", "archived"].includes(s),
      );
  }, [searchParams]);

  const providerFilters = useMemo(() => {
    const param = searchParams.get("provider");
    if (!param) return [];
    const knownProviders = Object.keys(PROVIDER_COLORS);
    return param
      .split(",")
      .filter((p): p is ProviderName => knownProviders.includes(p));
  }, [searchParams]);

  const executorFilters = useMemo(() => {
    const param = searchParams.get("executor");
    if (!param) return [];
    return param.split(",").filter(Boolean);
  }, [searchParams]);

  const ageFilter = useMemo(() => {
    const param = searchParams.get("age");
    if (param && ["3", "7", "14", "30"].includes(param))
      return param as AgeFilter;
    return undefined;
  }, [searchParams]);

  const setStatusFilters = useCallback(
    (filters: StatusFilter[]) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (filters.length > 0) {
          next.set("status", filters.join(","));
        } else {
          next.delete("status");
        }
        return next;
      });
    },
    [setSearchParams],
  );

  const setProviderFilters = useCallback(
    (filters: ProviderName[]) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (filters.length > 0) {
          next.set("provider", filters.join(","));
        } else {
          next.delete("provider");
        }
        return next;
      });
    },
    [setSearchParams],
  );

  const setExecutorFilters = useCallback(
    (filters: string[]) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (filters.length > 0) {
          next.set("executor", filters.join(","));
        } else {
          next.delete("executor");
        }
        return next;
      });
    },
    [setSearchParams],
  );

  const setAgeFilter = useCallback(
    (selected: AgeFilter[]) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (selected.length > 0 && selected[0]) {
          next.set("age", selected[0]);
        } else {
          next.delete("age");
        }
        return next;
      });
    },
    [setSearchParams],
  );

  // Include archived sessions when archived filter is selected
  const includeArchived = statusFilters.includes("archived");

  const { sessions, stats, projects, loading, error, hasMore, loadMore } =
    useGlobalSessions({
      projectId: projectFilter,
      searchQuery,
      includeArchived,
      includeStats: !projectFilter,
    });

  // Filter sessions based on status and provider filters (client-side)
  const filteredSessions = useMemo(() => {
    return sessions.filter((session) => {
      // Status filtering (empty = show all non-archived)
      if (statusFilters.length === 0) {
        // Default: show non-archived
        if (session.isArchived) return false;
      } else {
        // Check if session matches any selected status filter
        let matchesStatus = false;
        for (const status of statusFilters) {
          switch (status) {
            case "all":
              if (!session.isArchived) matchesStatus = true;
              break;
            case "unread":
              if (session.hasUnread && !session.isArchived)
                matchesStatus = true;
              break;
            case "starred":
              if (session.isStarred) matchesStatus = true;
              break;
            case "archived":
              if (session.isArchived) matchesStatus = true;
              break;
          }
        }
        if (!matchesStatus) return false;
      }

      // Provider filtering (empty = show all providers)
      if (providerFilters.length > 0) {
        if (!session.provider || !providerFilters.includes(session.provider)) {
          return false;
        }
      }

      // Executor filtering (empty = show all executors)
      if (executorFilters.length > 0) {
        const sessionExecutor = session.executor ?? "local";
        if (!executorFilters.includes(sessionExecutor)) {
          return false;
        }
      }

      // Age filtering (only show sessions older than N days)
      if (ageFilter) {
        const days = Number(ageFilter);
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        if (new Date(session.updatedAt).getTime() > cutoff) {
          return false;
        }
      }

      return true;
    });
  }, [sessions, statusFilters, providerFilters, executorFilters, ageFilter]);

  // Track which sessions have unsent drafts
  const drafts = useDrafts();

  // Build status filter options with global counts from server
  // When filtering by project, we don't have global stats, so omit counts
  const statusOptions = useMemo((): FilterOption<StatusFilter>[] => {
    // Only show counts when not filtering by project (global view)
    const showCounts = !projectFilter;

    return [
      {
        value: "all",
        label: t("globalSessionsStatusAll"),
        count: showCounts ? stats.totalCount : undefined,
      },
      {
        value: "unread",
        label: t("globalSessionsStatusUnread"),
        count: showCounts ? stats.unreadCount : undefined,
      },
      {
        value: "starred",
        label: t("globalSessionsStatusStarred"),
        count: showCounts ? stats.starredCount : undefined,
      },
      {
        value: "archived",
        label: t("globalSessionsStatusArchived"),
        count: showCounts ? stats.archivedCount : undefined,
      },
    ];
  }, [stats, projectFilter, t]);

  // Build provider filter options with global counts from server
  // When filtering by project, we don't have global stats, so omit counts
  const providerOptions = useMemo((): FilterOption<ProviderName>[] => {
    const showCounts = !projectFilter;
    const providerCounts = stats.providerCounts;

    // Only show providers that have sessions
    const options: FilterOption<ProviderName>[] = [];
    for (const provider of ALL_PROVIDERS) {
      const count = providerCounts[provider];
      if (count && count > 0) {
        options.push({
          value: provider,
          label: provider.charAt(0).toUpperCase() + provider.slice(1),
          count: showCounts ? count : undefined,
          color: PROVIDER_COLORS[provider],
        });
      }
    }
    return options;
  }, [stats.providerCounts, projectFilter]);

  // Age filter options
  const ageOptions = useMemo((): FilterOption<AgeFilter>[] => {
    return [
      { value: "3", label: "Older than 3 days" },
      { value: "3", label: t("globalSessionsAge3Days") },
      { value: "7", label: t("globalSessionsAge7Days") },
      { value: "14", label: t("globalSessionsAge14Days") },
      { value: "30", label: t("globalSessionsAge30Days") },
    ];
  }, [t]);

  // Build executor filter options with global counts from server
  const executorOptions = useMemo((): FilterOption<string>[] => {
    const showCounts = !projectFilter;
    const executorCounts = stats.executorCounts;

    // Only show executors that have sessions, sorted with "local" first
    const entries = Object.entries(executorCounts).filter(
      ([_, count]) => count > 0,
    );
    entries.sort((a, b) => {
      // "local" always comes first
      if (a[0] === "local") return -1;
      if (b[0] === "local") return 1;
      return a[0].localeCompare(b[0]);
    });

    return entries.map(([executor, count]) => ({
      value: executor,
      label: executor === "local" ? t("globalSessionsExecutorLocal") : executor,
      count: showCounts ? count : undefined,
    }));
  }, [stats.executorCounts, projectFilter, t]);

  // Handle search submit
  const handleSearch = useCallback(() => {
    const newParams = new URLSearchParams(searchParams);
    if (searchInput.trim()) {
      newParams.set("q", searchInput.trim());
    } else {
      newParams.delete("q");
    }
    setSearchParams(newParams);
  }, [searchInput, searchParams, setSearchParams]);

  // Handle project filter change
  const handleProjectFilter = useCallback(
    (selected: string[]) => {
      const newParams = new URLSearchParams(searchParams);
      if (selected.length > 0 && selected[0]) {
        newParams.set("project", selected[0]);
      } else {
        newParams.delete("project");
      }
      setSearchParams(newParams);
    },
    [searchParams, setSearchParams],
  );

  // Build project filter options
  const projectOptions = useMemo((): FilterOption<string>[] => {
    return projects.map((project) => ({
      value: project.id,
      label: project.name,
    }));
  }, [projects]);

  // Clear all filters
  const clearFilters = () => {
    setSearchInput("");
    setSearchParams(new URLSearchParams());
  };

  const isEmpty = filteredSessions.length === 0;
  const hasFilters =
    searchQuery ||
    projectFilter ||
    statusFilters.length > 0 ||
    providerFilters.length > 0 ||
    executorFilters.length > 0 ||
    ageFilter;

  return (
    <div
      className={
        isWideScreen
          ? "flex justify-center min-w-0 h-[100dvh] overflow-hidden"
          : "flex-1 flex flex-col min-h-0"
      }
    >
      <div
        className={
          isWideScreen
            ? "w-full flex flex-col h-[100dvh]"
            : "flex-1 flex flex-col min-h-0"
        }
      >
        <PageHeader
          title={t("globalSessionsTitle")}
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
          rightContent={
            <div className="relative hidden sm:block w-56 md:w-64">
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
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleSearch();
                  }
                }}
              />
            </div>
          }
        />

        <main className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-[1200px] mx-auto px-6 py-8 md:px-10 md:py-10">
            {/* Page intro */}
            <div className="mb-8">
              <h1 className="text-4xl md:text-5xl [font-family:var(--font-display)] text-[var(--text-primary)] mb-3">
                {t("globalSessionsTitle")}
              </h1>
              <p className="text-base md:text-lg text-[var(--text-muted)] max-w-2xl leading-relaxed">
                {t("globalSessionsSubtitle")}
              </p>
            </div>

            {/* Filter bar */}
            <div className="mb-8 flex flex-wrap items-center gap-3">
              <div className="flex flex-wrap items-center gap-2">
                {projectOptions.length > 0 && (
                  <FilterDropdown
                    label={t("inboxFilterProject")}
                    options={projectOptions}
                    selected={projectFilter ? [projectFilter] : []}
                    onChange={handleProjectFilter}
                    multiSelect={false}
                    placeholder={t("globalSessionsFilterProjectPlaceholder")}
                  />
                )}
                <FilterDropdown
                  label={t("globalSessionsFilterStatus")}
                  options={statusOptions}
                  selected={statusFilters}
                  onChange={setStatusFilters}
                  placeholder={t("globalSessionsStatusAll")}
                />
                {providerOptions.length > 1 && (
                  <FilterDropdown
                    label={t("globalSessionsFilterProvider")}
                    options={providerOptions}
                    selected={providerFilters}
                    onChange={setProviderFilters}
                    placeholder={t("globalSessionsStatusAll")}
                  />
                )}
                {executorOptions.length > 1 && (
                  <FilterDropdown
                    label={t("globalSessionsFilterExecutor")}
                    options={executorOptions}
                    selected={executorFilters}
                    onChange={setExecutorFilters}
                    placeholder={t("globalSessionsFilterMachinePlaceholder")}
                  />
                )}
                <FilterDropdown
                  label={t("globalSessionsFilterAge")}
                  options={ageOptions}
                  selected={ageFilter ? [ageFilter] : []}
                  onChange={setAgeFilter}
                  multiSelect={false}
                  placeholder={t("globalSessionsFilterAgePlaceholder")}
                />
              </div>
              {hasFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="rounded-md bg-transparent px-3 py-1.5 text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  {t("globalSessionsClearFilters")}
                </button>
              )}
            </div>

            {loading && sessions.length === 0 && (
              <p className="py-8 text-center text-sm text-[var(--text-muted)]">
                {t("sidebarLoadingSessions")}
              </p>
            )}

            {error && (
              <p className="py-8 text-center text-sm text-[var(--error-color)]">
                {t("projectsErrorPrefix")} {error.message}
              </p>
            )}

            {!loading && !error && isEmpty && (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <span className="text-5xl mb-4" aria-hidden="true">
                  &#128172;
                </span>
                <h3 className="text-2xl [font-family:var(--font-display)] text-[var(--text-primary)]">
                  {t("globalSessionsNoResultsTitle")}
                </h3>
                <p className="text-[var(--text-muted)] mt-2">
                  {hasFilters
                    ? t("globalSessionsNoResultsFiltered")
                    : t("globalSessionsNoResultsEmpty")}
                </p>
              </div>
            )}

            {!error && !isEmpty && (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filteredSessions.map((session, index) => (
                    <div
                      key={session.id}
                      className={index === 0 ? "md:col-span-2" : ""}
                    >
                      <SessionListItem
                        sessionId={session.id}
                        projectId={session.projectId}
                        title={getSessionDisplayTitle(session)}
                        fullTitle={getSessionDisplayTitle(session)}
                        updatedAt={session.updatedAt}
                        hasUnread={session.hasUnread}
                        activity={session.activity}
                        pendingInputType={session.pendingInputType}
                        status={session.ownership}
                        provider={session.provider}
                        executor={session.executor}
                        isStarred={session.isStarred}
                        isArchived={session.isArchived}
                        mode={index === 0 ? "card" : "grid"}
                        showContextUsage={false}
                        showProjectName={!projectFilter}
                        projectName={session.projectName}
                        basePath={basePath}
                        messageCount={session.messageCount}
                        hasDraft={drafts.has(session.id)}
                      />
                    </div>
                  ))}
                </div>

                {hasMore && (
                  <div className="flex justify-center py-4">
                    <button
                      type="button"
                      onClick={loadMore}
                      className="inline-flex items-center gap-1.5 rounded-2xl border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-4 py-1.5 text-xs text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-default disabled:opacity-60"
                      disabled={loading}
                    >
                      {loading
                        ? t("gitStatusLoading")
                        : t("globalSessionsLoadMore")}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
