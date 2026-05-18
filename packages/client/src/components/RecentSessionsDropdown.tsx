import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import type { GlobalSessionItem } from "../api/client";
import type { AgentActivity } from "../hooks/useFileActivity";
import { useGlobalSessions } from "../hooks/useGlobalSessions";
import { ThinkingIndicator } from "./ThinkingIndicator";

const MAX_RECENT_SESSIONS = 10;

interface RecentSessionsDropdownProps {
  /** Current session ID (will be excluded from list) */
  currentSessionId: string;
  /** Whether the dropdown is open */
  isOpen: boolean;
  /** Called when dropdown should close */
  onClose: () => void;
  /** Called when navigating to a session */
  onNavigate: (sessionId: string, projectId: string) => void;
  /** Trigger element ref for positioning */
  triggerRef: React.RefObject<HTMLElement | null>;
  /** Base path prefix for relay mode (e.g., "/remote/my-server") */
  basePath?: string;
  /** Optional path builder for alternate session routes such as editor mode */
  getSessionPath?: (projectId: string, sessionId: string) => string;
}

/** Format time as "Xm ago" style */
function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Get display title */
function getDisplayTitle(session: GlobalSessionItem): string {
  return session.customTitle || session.title || "Untitled";
}

/** Compact status indicator */
function StatusIndicator({ session }: { session: GlobalSessionItem }) {
  const activity = session.activity as AgentActivity | undefined;

  // In-turn/thinking indicator
  if (activity === "in-turn") {
    return <ThinkingIndicator />;
  }

  // Needs input
  if (session.pendingInputType) {
    const label = session.pendingInputType === "tool-approval" ? "Appr" : "Q";
    return (
      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[var(--radius-sm)] whitespace-nowrap bg-[var(--status-badge-input-bg)] text-[var(--status-badge-input-text)]">
        {label}
      </span>
    );
  }

  // External session
  if (session.ownership.owner === "external") {
    return (
      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[var(--radius-sm)] whitespace-nowrap bg-[var(--status-badge-external-bg)] text-[var(--status-badge-external-text)]">
        Ext
      </span>
    );
  }

  return null;
}

export function RecentSessionsDropdown({
  currentSessionId,
  isOpen,
  onClose,
  onNavigate,
  triggerRef,
  basePath = "",
  getSessionPath,
}: RecentSessionsDropdownProps) {
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch recent sessions across all projects
  const { sessions } = useGlobalSessions({
    limit: MAX_RECENT_SESSIONS + 5,
    includeStats: false,
  });

  // Filter out current session and limit
  const recentSessions = sessions
    .filter((s) => s.id !== currentSessionId && !s.isArchived)
    .slice(0, MAX_RECENT_SESSIONS);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose, triggerRef]);

  // Close on scroll
  useEffect(() => {
    if (!isOpen) return;

    const handleScroll = () => onClose();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Position dropdown below trigger
  const triggerRect = triggerRef.current?.getBoundingClientRect();
  const style: React.CSSProperties = triggerRect
    ? {
        position: "fixed",
        top: triggerRect.bottom + 4,
        left: Math.max(8, triggerRect.left - 100), // Offset left to align better
        width: "min(830px, calc(100vw - 32px))",
      }
    : {};

  const dropdown = (
    <div
      ref={dropdownRef}
      className="bg-[var(--bg-surface)] border border-[var(--border-color)] rounded-[var(--radius-md)] shadow-[0_4px_16px_rgba(0,0,0,0.4)] min-w-[280px] max-w-[min(830px,calc(100vw-32px))] z-[10001] overflow-hidden"
      style={style}
    >
      <div className="px-3 py-2 [font-size:var(--font-size-xs)] font-semibold text-[var(--text-muted)] uppercase tracking-wider border-b border-[var(--border-color)]">
        Recent Sessions
      </div>
      {recentSessions.length === 0 ? (
        <div className="px-3 py-4 text-[var(--text-muted)] [font-size:var(--font-size-sm)]">
          No other sessions
        </div>
      ) : (
        <div className="max-h-[400px] overflow-y-auto">
          {recentSessions.map((session) => (
            <Link
              key={session.id}
              to={
                getSessionPath
                  ? getSessionPath(session.projectId, session.id)
                  : `${basePath}/projects/${session.projectId}/sessions/${session.id}`
              }
              className={`flex items-center justify-between gap-3 px-3 py-2.5 no-underline text-[var(--text-primary)] border-b border-[var(--border-subtle)] transition-colors duration-100 hover:bg-[var(--bg-hover)] active:bg-[var(--bg-active)] ${session.hasUnread ? "unread" : ""}`}
              onClick={() => {
                onNavigate(session.id, session.projectId);
                onClose();
              }}
            >
              <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span className="flex items-center gap-1.5 [font-size:var(--font-size-sm)] font-normal text-[var(--text-secondary)] min-w-0">
                  {session.isStarred && (
                    <span className="text-[var(--accent-star)] shrink-0 text-xs">
                      &#x2605;
                    </span>
                  )}
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                    {getDisplayTitle(session)}
                  </span>
                </span>
                <span className="[font-size:var(--font-size-xs)] text-[var(--text-muted)] overflow-hidden text-ellipsis whitespace-nowrap">
                  {session.projectName}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <StatusIndicator session={session} />
                <span className="[font-size:var(--font-size-xs)] text-[var(--text-muted)] whitespace-nowrap">
                  {formatRelativeTime(session.updatedAt)}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );

  // Use portal to escape any overflow clipping
  return createPortal(dropdown, document.body);
}
