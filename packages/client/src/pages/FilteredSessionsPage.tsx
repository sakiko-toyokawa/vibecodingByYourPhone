import { useMemo, useState } from "react";
import type { GlobalSessionItem } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { SessionListItem } from "../components/SessionListItem";
import { useDrafts } from "../hooks/useDrafts";
import { useGlobalSessions } from "../hooks/useGlobalSessions";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";
import { getSessionDisplayTitle } from "../utils";

interface FilteredSessionsPageProps {
  timeFilter: "recent" | "older";
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

type TFunction = ReturnType<typeof useI18n>["t"];

function getPageTitle(timeFilter: "recent" | "older", t: TFunction): string {
  return timeFilter === "recent"
    ? t("recentSessionsTitle")
    : t("olderSessionsTitle");
}

function getPageSubtitle(timeFilter: "recent" | "older", t: TFunction): string {
  return timeFilter === "recent"
    ? t("recentSessionsSubtitle")
    : t("olderSessionsSubtitle");
}

function getEmptyTitle(timeFilter: "recent" | "older", t: TFunction): string {
  return timeFilter === "recent"
    ? t("recentSessionsNoResults")
    : t("olderSessionsNoResults");
}

function filterByTime(
  sessions: GlobalSessionItem[],
  timeFilter: "recent" | "older",
): GlobalSessionItem[] {
  const now = Date.now();
  const cutoff = now - ONE_DAY_MS;

  return sessions.filter((s) => {
    if (s.isArchived) return false;
    const updatedAt = new Date(s.updatedAt).getTime();
    if (timeFilter === "recent") {
      return updatedAt >= cutoff;
    }
    return updatedAt < cutoff;
  });
}

export function FilteredSessionsPage({
  timeFilter,
}: FilteredSessionsPageProps) {
  const { t } = useI18n();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const basePath = useRemoteBasePath();

  const [searchInput, setSearchInput] = useState("");

  const { sessions, loading, error } = useGlobalSessions({
    limit: 100,
    includeStats: false,
  });

  const drafts = useDrafts();

  const filteredSessions = useMemo(() => {
    let result = filterByTime(sessions, timeFilter);

    if (searchInput.trim()) {
      const query = searchInput.trim().toLowerCase();
      result = result.filter((s) => {
        const title = getSessionDisplayTitle(s).toLowerCase();
        const projectName = (s.projectName ?? "").toLowerCase();
        return title.includes(query) || projectName.includes(query);
      });
    }

    return result;
  }, [sessions, timeFilter, searchInput]);

  const isEmpty = filteredSessions.length === 0;
  const hasSearch = searchInput.trim().length > 0;

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
          title={getPageTitle(timeFilter, t)}
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
              />
            </div>
          }
        />

        <main className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-[1200px] mx-auto px-6 py-8 md:px-10 md:py-10">
            {/* Page intro */}
            <div className="mb-8">
              <h1 className="text-4xl md:text-5xl [font-family:var(--font-display)] text-[var(--text-primary)] mb-3">
                {getPageTitle(timeFilter, t)}
              </h1>
              <p className="text-base md:text-lg text-[var(--text-muted)] max-w-2xl leading-relaxed">
                {getPageSubtitle(timeFilter, t)}
              </p>
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
                  {getEmptyTitle(timeFilter, t)}
                </h3>
                <p className="text-[var(--text-muted)] mt-2">
                  {hasSearch
                    ? t("globalSessionsNoResultsFiltered")
                    : t("globalSessionsNoResultsEmpty")}
                </p>
              </div>
            )}

            {!error && !isEmpty && (
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
                      showProjectName
                      projectName={session.projectName}
                      basePath={basePath}
                      messageCount={session.messageCount}
                      hasDraft={drafts.has(session.id)}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
