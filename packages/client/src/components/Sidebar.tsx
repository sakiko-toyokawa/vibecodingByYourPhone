import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useOptionalRemoteConnection } from "../contexts/RemoteConnectionContext";
import { useDrafts } from "../hooks/useDrafts";
import { useGlobalSessions } from "../hooks/useGlobalSessions";
import { useNeedsAttentionBadge } from "../hooks/useNeedsAttentionBadge";
import { resolvePreferredProjectId } from "../hooks/useRecentProject";
import { useRecentProjects } from "../hooks/useRecentProjects";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import { getSessionDisplayTitle } from "../utils";
import { AgentsNavItem } from "./AgentsNavItem";
import { SessionListItem } from "./SessionListItem";
import {
  SidebarIcons,
  SidebarNavItem,
  SidebarNavSection,
} from "./SidebarNavItem";

const SWIPE_THRESHOLD = 50;
const SWIPE_ENGAGE_THRESHOLD = 15;
const RECENT_SESSIONS_INITIAL = 12;
const RECENT_SESSIONS_INCREMENT = 10;

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: () => void;
  currentSessionId?: string;
  isDesktop?: boolean;
  isCollapsed?: boolean;
  onToggleExpanded?: () => void;
  sidebarWidth?: number;
  onResizeStart?: () => void;
  onResize?: (width: number) => void;
  onResizeEnd?: () => void;
}

export function Sidebar({
  isOpen,
  onClose,
  onNavigate,
  currentSessionId,
  isDesktop = false,
  isCollapsed = false,
  onToggleExpanded,
  sidebarWidth,
  onResizeStart,
  onResize,
  onResizeEnd,
}: SidebarProps) {
  const { t } = useI18n();
  const basePath = useRemoteBasePath();
  const navigate = useNavigate();
  const remoteConnection = useOptionalRemoteConnection();
  const { sessions: globalSessions, loading: globalLoading } =
    useGlobalSessions({ limit: 50, includeStats: false });
  const { sessions: starredSessions, loading: starredLoading } =
    useGlobalSessions({
      starred: true,
      limit: 100,
      includeStats: false,
    });
  const sessionsLoading = globalLoading || starredLoading;
  const { version: versionInfo } = useVersion();
  const capabilities = versionInfo?.capabilities ?? [];
  const inboxCount = useNeedsAttentionBadge();
  const { recentProjects, projects } = useRecentProjects();
  const newSessionProjectId = resolvePreferredProjectId(
    projects,
    recentProjects[0]?.id,
  );
  const drafts = useDrafts();

  const sidebarRef = useRef<HTMLElement>(null);
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const swipeEngaged = useRef(false);
  const resizeStartX = useRef<number | null>(null);
  const resizeStartWidth = useRef<number | null>(null);

  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isResizing, setIsResizing] = useState(false);
  const [starredSessionsLimit, setStarredSessionsLimit] = useState(
    RECENT_SESSIONS_INITIAL,
  );

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
    touchStartY.current = e.touches[0]?.clientY ?? null;
    swipeEngaged.current = false;
    setSwipeOffset(0);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const currentX = e.touches[0]?.clientX;
    const currentY = e.touches[0]?.clientY;
    if (currentX === undefined || currentY === undefined) return;

    const diffX = currentX - touchStartX.current;
    const diffY = currentY - touchStartY.current;

    if (!swipeEngaged.current) {
      const absDiffX = Math.abs(diffX);
      const absDiffY = Math.abs(diffY);
      if (
        absDiffX > SWIPE_ENGAGE_THRESHOLD &&
        absDiffX > absDiffY &&
        diffX < 0
      ) {
        swipeEngaged.current = true;
      } else {
        return;
      }
    }

    if (diffX < 0) {
      setSwipeOffset(diffX);
    }
  };

  const handleTouchEnd = () => {
    if (swipeEngaged.current && swipeOffset < -SWIPE_THRESHOLD) {
      onClose();
    }
    touchStartX.current = null;
    touchStartY.current = null;
    swipeEngaged.current = false;
    setSwipeOffset(0);
  };

  const handleResizeMouseDown = (e: React.MouseEvent) => {
    if (!isDesktop || isCollapsed || !sidebarWidth) return;
    e.preventDefault();
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = sidebarWidth;
    setIsResizing(true);
    onResizeStart?.();
  };

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (resizeStartX.current === null || resizeStartWidth.current === null) {
        return;
      }
      const diff = e.clientX - resizeStartX.current;
      onResize?.(resizeStartWidth.current + diff);
    };

    const handleMouseUp = () => {
      resizeStartX.current = null;
      resizeStartWidth.current = null;
      setIsResizing(false);
      onResizeEnd?.();
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, onResize, onResizeEnd]);

  const handleSwitchHost = () => {
    remoteConnection?.disconnect();
    navigate("/login");
    onNavigate();
  };

  const filteredStarredSessions = useMemo(
    () => starredSessions.filter((s) => !s.isArchived),
    [starredSessions],
  );

  if (!isDesktop && !isOpen) return null;

  const showSessionLists = !isCollapsed;
  const shellClasses = isDesktop
    ? "relative inset-auto h-full w-full max-w-none animate-none border-r-0 bg-transparent shadow-none"
    : "fixed inset-y-0 left-0 z-[101] w-[280px] max-w-[85vw] animate-[slideIn_0.2s_ease-out] border-r border-[var(--border-color)] bg-[var(--bg-surface)] shadow-[0_18px_60px_rgba(20,20,19,0.12)]";

  return (
    <>
      {!isDesktop && (
        <div
          className="fixed inset-0 z-[100] bg-[var(--bg-overlay)] animate-[fadeIn_0.15s_ease-out]"
          onClick={onClose}
          onKeyDown={(e) => e.key === "Escape" && onClose()}
          role="button"
          tabIndex={0}
          aria-label={t("actionCloseSidebar")}
        />
      )}

      <aside
        ref={sidebarRef}
        className={`${shellClasses} flex flex-col pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)]`}
        onTouchStart={!isDesktop ? handleTouchStart : undefined}
        onTouchMove={!isDesktop ? handleTouchMove : undefined}
        onTouchEnd={!isDesktop ? handleTouchEnd : undefined}
        style={
          !isDesktop && swipeOffset < 0
            ? { transform: `translateX(${swipeOffset}px)`, transition: "none" }
            : undefined
        }
      >
        <div
          className={`flex items-center ${
            isCollapsed
              ? "justify-center px-2 py-3"
              : "justify-between px-4 py-4"
          }`}
        >
          {isDesktop && isCollapsed ? (
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-muted)] shadow-sm transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              onClick={onToggleExpanded}
              title={t("actionExpandSidebar")}
              aria-label={t("actionExpandSidebar")}
            >
              <span className="text-sm font-medium">→</span>
            </button>
          ) : (
            <>
              <div className="flex flex-col">
                <h1
                  className="text-[1.4rem] leading-tight text-[var(--text-primary)]"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {"Yep Anywhere"}
                </h1>
                {!isCollapsed && (
                  <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                    {"ARCHIVAL VIEW"}
                  </span>
                )}
              </div>
              {!isDesktop && (
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-muted)] shadow-sm transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  onClick={onClose}
                  aria-label={t("actionCloseSidebar")}
                >
                  <span className="text-sm font-medium">×</span>
                </button>
              )}
            </>
          )}
        </div>

        <div
          className={`flex flex-col ${isCollapsed ? "px-2 py-2" : "px-3 py-2"}`}
        >
          {isCollapsed ? (
            <Link
              to={
                newSessionProjectId
                  ? `${basePath}/new-session?projectId=${encodeURIComponent(newSessionProjectId)}`
                  : `${basePath}/new-session`
              }
              className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--primary)] text-[var(--on-primary)] transition-opacity hover:opacity-90"
              onClick={onNavigate}
              title={t("sidebarNewSession")}
              aria-label={t("sidebarNewSession")}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <line
                  x1="12"
                  y1="7"
                  x2="12"
                  y2="17"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <line
                  x1="7"
                  y1="12"
                  x2="17"
                  y2="12"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </Link>
          ) : (
            <Link
              to={
                newSessionProjectId
                  ? `${basePath}/new-session?projectId=${encodeURIComponent(newSessionProjectId)}`
                  : `${basePath}/new-session`
              }
              className="flex items-center justify-center gap-2 rounded-md bg-[var(--primary)] px-4 py-2.5 text-sm font-medium text-[var(--on-primary)] no-underline transition-opacity hover:opacity-90"
              onClick={onNavigate}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <line
                  x1="12"
                  y1="7"
                  x2="12"
                  y2="17"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <line
                  x1="7"
                  y1="12"
                  x2="17"
                  y2="12"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
              {t("sidebarNewSession")}
            </Link>
          )}
        </div>

        <div
          className={`flex-1 overflow-y-auto ${isCollapsed ? "px-2 pb-3" : "px-3 pb-4"}`}
        >
          <SidebarNavSection>
            <SidebarNavItem
              to="/inbox"
              icon={SidebarIcons.inbox}
              label={t("sidebarInbox")}
              badge={inboxCount}
              onClick={onNavigate}
              basePath={basePath}
              collapsed={isCollapsed}
            />
            <SidebarNavItem
              to="/sessions"
              icon={SidebarIcons.allSessions}
              label={t("sidebarAllSessions")}
              onClick={onNavigate}
              basePath={basePath}
              collapsed={isCollapsed}
            />
            <SidebarNavItem
              to="/recent"
              icon={SidebarIcons.recents}
              label={t("sidebarRecent")}
              onClick={onNavigate}
              basePath={basePath}
              collapsed={isCollapsed}
            />
            <SidebarNavItem
              to="/older"
              icon={SidebarIcons.older}
              label={t("sidebarOlder")}
              onClick={onNavigate}
              basePath={basePath}
              collapsed={isCollapsed}
            />
            <SidebarNavItem
              to="/projects"
              icon={SidebarIcons.projects}
              label={t("sidebarProjects")}
              onClick={onNavigate}
              basePath={basePath}
              collapsed={isCollapsed}
            />
            {capabilities.includes("git-status") && (
              <SidebarNavItem
                to="/git-status"
                icon={SidebarIcons.sourceControl}
                label={t("sidebarSourceControl")}
                onClick={onNavigate}
                basePath={basePath}
                collapsed={isCollapsed}
              />
            )}
            {(capabilities.includes("deviceBridge") ||
              capabilities.includes("deviceBridge-download")) && (
              <SidebarNavItem
                to="/devices"
                icon={SidebarIcons.emulator}
                label={t("sidebarDevices")}
                onClick={onNavigate}
                basePath={basePath}
                collapsed={isCollapsed}
              />
            )}
            <AgentsNavItem
              onClick={onNavigate}
              basePath={basePath}
              collapsed={isCollapsed}
            />
            <SidebarNavItem
              to="/loops"
              icon={SidebarIcons.loops}
              label={t("sidebarLoops")}
              onClick={onNavigate}
              basePath={basePath}
              collapsed={isCollapsed}
            />
            <SidebarNavItem
              to="/settings"
              icon={SidebarIcons.settings}
              label={t("sidebarSettings")}
              onClick={onNavigate}
              basePath={basePath}
              collapsed={isCollapsed}
            />
            {remoteConnection && !isCollapsed && (
              <button
                type="button"
                className="mt-1 flex items-center gap-2 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3.5 py-2 text-left text-xs text-[var(--text-primary)] shadow-sm transition-colors hover:bg-[var(--bg-hover)]"
                onClick={handleSwitchHost}
              >
                <span>{t("sidebarSwitchHost")}</span>
              </button>
            )}
          </SidebarNavSection>

          {showSessionLists && filteredStarredSessions.length > 0 && (
            <div className="mb-4 mt-3">
              <h3
                className="mb-2 px-3 text-xs font-semibold tracking-wide uppercase text-[var(--text-dimmed)]"
                style={{ fontFamily: "var(--font-body)" }}
              >
                {t("sidebarSectionStarred")}
              </h3>
              <ul className="m-0 list-none p-0">
                {filteredStarredSessions
                  .slice(0, starredSessionsLimit)
                  .map((session) => (
                    <SessionListItem
                      key={session.id}
                      sessionId={session.id}
                      projectId={session.projectId}
                      title={getSessionDisplayTitle(session)}
                      fullTitle={getSessionDisplayTitle(session)}
                      provider={session.provider}
                      status={session.ownership}
                      pendingInputType={session.pendingInputType}
                      hasUnread={session.hasUnread}
                      isStarred={session.isStarred}
                      isArchived={session.isArchived}
                      mode="compact"
                      isCurrent={session.id === currentSessionId}
                      activity={session.activity}
                      onNavigate={onNavigate}
                      showProjectName
                      projectName={session.projectName}
                      basePath={basePath}
                      messageCount={session.messageCount}
                      hasDraft={drafts.has(session.id)}
                    />
                  ))}
              </ul>
              {filteredStarredSessions.length > starredSessionsLimit && (
                <button
                  type="button"
                  className="block w-full px-3.5 py-1.5 text-left text-xs text-[var(--text-dimmed)] transition-colors hover:text-[var(--text-secondary)]"
                  onClick={() =>
                    setStarredSessionsLimit(
                      (prev) => prev + RECENT_SESSIONS_INCREMENT,
                    )
                  }
                >
                  {t("actionShowMore", {
                    count: Math.min(
                      RECENT_SESSIONS_INCREMENT,
                      filteredStarredSessions.length - starredSessionsLimit,
                    ),
                  })}
                </button>
              )}
            </div>
          )}

          {showSessionLists && filteredStarredSessions.length === 0 && (
            <p className="p-4 text-center text-xs text-[var(--text-dimmed)]">
              {sessionsLoading
                ? t("sidebarLoadingSessions")
                : t("sidebarNoSessions")}
            </p>
          )}
        </div>

        {!isCollapsed && (
          <div className="shrink-0 border-t border-[var(--border-subtle)] px-3 pb-4 pt-3">
            <div className="flex flex-col gap-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
                {remoteConnection?.currentRelayUsername
                  ? t("sidebarConnectedTo")
                  : t("sidebarHost")}
              </div>
              <div className="truncate text-[11px] text-[var(--text-secondary)]">
                {remoteConnection?.currentRelayUsername ?? window.location.host}
              </div>
              {remoteConnection && (
                <button
                  type="button"
                  className="mt-1 text-left text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                  onClick={handleSwitchHost}
                >
                  {t("sidebarSwitchHost")}
                </button>
              )}
            </div>
          </div>
        )}

        {isDesktop && !isCollapsed && (
          <div
            className={`absolute -right-[3px] top-0 bottom-0 z-10 w-1.5 cursor-col-resize bg-transparent transition-colors hover:bg-[var(--accent-rust)] hover:opacity-60 ${
              isResizing ? "bg-[var(--accent-rust)] opacity-80" : ""
            }`}
            onMouseDown={handleResizeMouseDown}
            role="separator"
            aria-orientation="vertical"
            aria-label={t("actionResizeSidebar")}
            tabIndex={0}
          />
        )}
      </aside>
    </>
  );
}
