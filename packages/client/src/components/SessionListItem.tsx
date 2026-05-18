import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { AgentActivity } from "../hooks/useFileActivity";
import { useI18n } from "../i18n";
import type {
  ContextUsage,
  PendingInputType,
  ProviderName,
  SessionStatus,
} from "../types";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import { SessionMenu } from "./SessionMenu";
import { SessionStatusBadge } from "./StatusBadge";
import { ThinkingIndicator } from "./ThinkingIndicator";

interface SessionListItemProps {
  sessionId: string;
  projectId: string;
  title: string | null;
  fullTitle?: string | null;
  projectName?: string;
  updatedAt?: string;
  hasUnread?: boolean;
  activity?: AgentActivity;
  pendingInputType?: PendingInputType;
  contextUsage?: ContextUsage;
  status?: SessionStatus;
  provider?: ProviderName;
  executor?: string;
  mode: "card" | "compact" | "grid";
  showProjectName?: boolean;
  showTimestamp?: boolean;
  showContextUsage?: boolean;
  showStatusBadge?: boolean;
  customBadge?: { label: string; className: string } | null;
  isStarred?: boolean;
  isArchived?: boolean;
  onToggleStar?: () => void;
  onToggleArchive?: () => void;
  onToggleRead?: () => void;
  onRename?: () => void;
  isCurrent?: boolean;
  isSelected?: boolean;
  isSelectionMode?: boolean;
  onSelect?: (sessionId: string, selected: boolean) => void;
  onNavigate?: () => void;
  hasDraft?: boolean;
  basePath?: string;
  messageCount?: number;
}

export function SessionListItem({
  sessionId,
  projectId,
  title,
  fullTitle,
  projectName,
  updatedAt,
  hasUnread: hasUnreadProp,
  activity,
  pendingInputType,
  contextUsage,
  status,
  provider,
  executor,
  mode,
  showProjectName = false,
  showTimestamp = true,
  showContextUsage = true,
  showStatusBadge = true,
  customBadge,
  isStarred: isStarredProp,
  isArchived: isArchivedProp,
  onToggleStar,
  onToggleArchive,
  onToggleRead,
  onRename,
  isCurrent = false,
  isSelected = false,
  isSelectionMode = false,
  onSelect,
  onNavigate,
  hasDraft = false,
  basePath = "",
  messageCount,
}: SessionListItemProps) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [localIsStarred, setLocalIsStarred] = useState<boolean | undefined>();
  const [localIsArchived, setLocalIsArchived] = useState<boolean | undefined>();
  const [isEditing, setIsEditing] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [localTitle, setLocalTitle] = useState<string | undefined>();
  const [localHasUnread, setLocalHasUnread] = useState<boolean | undefined>();
  const renameInputRef = useRef<HTMLInputElement>(null);
  const isSavingRef = useRef(false);

  const isStarred = localIsStarred ?? isStarredProp;
  const isArchived = localIsArchived ?? isArchivedProp;
  const hasUnread = localHasUnread ?? hasUnreadProp;
  const isNewSession =
    !localTitle &&
    !title &&
    (messageCount === 0 || (messageCount == null && activity === "in-turn"));
  const displayTitle =
    localTitle ?? title ?? (isNewSession ? "New session" : "Untitled session");

  useEffect(() => {
    if (!isEditing) return;
    setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
  }, [isEditing]);

  const handleToggleStar = async () => {
    const next = !isStarred;
    setLocalIsStarred(next);
    try {
      await api.updateSessionMetadata(sessionId, { starred: next });
      onToggleStar?.();
    } catch (err) {
      console.error("Failed to update star status:", err);
      setLocalIsStarred(undefined);
    }
  };

  const handleToggleArchive = async () => {
    const next = !isArchived;
    setLocalIsArchived(next);
    try {
      await api.updateSessionMetadata(sessionId, { archived: next });
      onToggleArchive?.();
    } catch (err) {
      console.error("Failed to update archive status:", err);
      setLocalIsArchived(undefined);
    }
  };

  const handleToggleRead = async () => {
    const next = !hasUnread;
    setLocalHasUnread(next);
    try {
      if (next) {
        await api.markSessionUnread(sessionId);
      } else {
        await api.markSessionSeen(sessionId);
      }
      onToggleRead?.();
    } catch (err) {
      console.error("Failed to update read status:", err);
      setLocalHasUnread(undefined);
    }
  };

  const handleCancelEditing = () => {
    if (isSavingRef.current) return;
    setIsEditing(false);
    setRenameValue("");
  };

  const handleSaveRename = async () => {
    if (!renameValue.trim() || isSaving) return;
    if (renameValue.trim() === displayTitle) {
      handleCancelEditing();
      return;
    }
    isSavingRef.current = true;
    setIsSaving(true);
    try {
      await api.updateSessionMetadata(sessionId, {
        title: renameValue.trim(),
      });
      setLocalTitle(renameValue.trim());
      setIsEditing(false);
      onRename?.();
    } catch (err) {
      console.error("Failed to rename session:", err);
    } finally {
      setIsSaving(false);
      isSavingRef.current = false;
    }
  };

  const handleRenameBlur = () => {
    if (isSavingRef.current) return;
    if (!renameValue.trim() || renameValue.trim() === displayTitle) {
      handleCancelEditing();
      return;
    }
    handleSaveRename();
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSaveRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancelEditing();
    }
  };

  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    onSelect?.(sessionId, e.target.checked);
  };

  const formatRelativeTime = (timestamp: string): string => {
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
  };

  const getCompactActivityIndicator = () => {
    if (status?.owner === "external") {
      return (
        <span className="shrink-0 rounded-full bg-[var(--status-badge-external-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--status-badge-external-text)]">
          Ext
        </span>
      );
    }

    if (pendingInputType) {
      const label = pendingInputType === "tool-approval" ? "Appr" : "Q";
      return (
        <span className="shrink-0 rounded-full bg-[var(--status-badge-input-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--status-badge-input-text)]">
          {label}
        </span>
      );
    }

    if (activity === "in-turn") {
      return <ThinkingIndicator />;
    }

    return null;
  };

  const StarIcon = ({
    filled,
    size = 10,
  }: { filled: boolean; size?: number }) => (
    <svg
      className="shrink-0 text-[var(--warning-color)]"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );

  return (
    <li
      className={`group relative ${
        mode === "grid"
          ? "block h-full"
          : mode === "card"
            ? "block"
            : "flex items-center gap-2"
      } ${isSelectionMode ? "select-none" : ""}`}
    >
      {onSelect && (
        <input
          type="checkbox"
          className={`h-[18px] w-[18px] cursor-pointer accent-[var(--accent-rust)] ${mode === "grid" ? "absolute top-3 left-3 z-10" : "shrink-0"}`}
          checked={isSelected}
          onChange={handleCheckboxChange}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${displayTitle}`}
        />
      )}

      {isEditing ? (
        <input
          ref={renameInputRef}
          type="text"
          className="flex-1 rounded-md border border-[var(--border-input)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--focus-border)]"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={handleRenameBlur}
          onKeyDown={handleRenameKeyDown}
          disabled={isSaving}
        />
      ) : (
        <Link
          to={`${basePath}/projects/${projectId}/sessions/${sessionId}`}
          onClick={(e) => {
            if (isSelectionMode) {
              e.preventDefault();
            }
            onNavigate?.();
          }}
          title={fullTitle || displayTitle}
          className={
            mode === "grid"
              ? `flex flex-col h-full rounded-lg border p-5 no-underline transition-colors ${
                  isCurrent
                    ? "border-[var(--text-primary)]/25 bg-[var(--bg-surface)] shadow-sm"
                    : "border-[var(--border-color)] bg-[var(--bg-surface)] hover:border-[var(--border-subtle)]"
                }`
              : mode === "card"
                ? `flex flex-col rounded-lg border px-6 py-6 no-underline transition-colors ${
                    isCurrent
                      ? "border-[var(--text-primary)]/25 bg-[var(--bg-surface)] shadow-sm"
                      : "border-[var(--border-color)] bg-[var(--bg-surface)] hover:border-[var(--border-subtle)]"
                  }`
                : `flex flex-1 items-center justify-between overflow-hidden rounded-xl px-3 py-2.5 no-underline transition-colors ${
                    isCurrent
                      ? "bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-sm ring-1 ring-[var(--border-color)]"
                      : hasUnread
                        ? "bg-[var(--bg-secondary)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                        : "text-[var(--text-primary)] hover:bg-[var(--bg-hover)]/70"
                   }`
          }
        >
          {mode === "card" ? (
            <>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  {hasDraft && (
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--accent-rust)] bg-[var(--accent-rust)]/10 px-2 py-0.5 rounded">
                      Draft
                    </span>
                  )}
                  {isArchived && (
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] bg-[var(--bg-tertiary)] px-2 py-0.5 rounded">
                      Archived
                    </span>
                  )}
                  {!hasDraft && !isArchived && getCompactActivityIndicator()}
                </div>
                {showTimestamp && updatedAt && (
                  <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-dimmed)]">
                    {formatRelativeTime(updatedAt)}
                  </span>
                )}
              </div>

              <h2 className="text-2xl md:text-[1.75rem] [font-family:var(--font-display)] text-[var(--text-primary)] leading-tight">
                {isNewSession && <ThinkingIndicator className="inline mr-2" />}
                {displayTitle}
              </h2>

              <div className="mt-auto pt-6 flex items-center justify-between">
                <span className="text-sm font-medium text-[var(--accent-rust)]">
                  {t("globalSessionsResume")} →
                </span>
                {showProjectName && projectName && (
                  <span className="text-[11px] text-[var(--text-muted)]">
                    {projectName}
                  </span>
                )}
              </div>
            </>
          ) : mode === "grid" ? (
            <>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  {getCompactActivityIndicator()}
                </div>
                {showTimestamp && updatedAt && (
                  <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-dimmed)]">
                    {formatRelativeTime(updatedAt)}
                  </span>
                )}
              </div>

              <h3 className="text-lg [font-family:var(--font-display)] text-[var(--text-primary)] leading-snug">
                {isStarred && <StarIcon filled size={10} />}
                {isNewSession && <ThinkingIndicator className="inline mr-1" />}
                {displayTitle}
              </h3>

              {(hasDraft || isArchived) && (
                <div className="mt-2 flex items-center gap-2">
                  {hasDraft && (
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--accent-rust)] bg-[var(--accent-rust)]/10 px-2 py-0.5 rounded">
                      Draft
                    </span>
                  )}
                  {isArchived && (
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] bg-[var(--bg-tertiary)] px-2 py-0.5 rounded">
                      Archived
                    </span>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {isStarred && <StarIcon filled />}
                <span
                  className={`flex-1 overflow-hidden text-ellipsis whitespace-nowrap [font-size:var(--font-size-sm)] ${
                    hasUnread ? "font-semibold text-[var(--text-primary)]" : ""
                  }`}
                >
                  {isNewSession && <ThinkingIndicator className="mr-1" />}
                  {displayTitle}
                </span>
                {hasDraft && (
                  <span className="shrink-0 rounded bg-[var(--warning-color)]/20 px-1.5 py-0.5 text-[10px] font-medium text-[var(--warning-color)]">
                    Draft
                  </span>
                )}
              </span>
              {showProjectName && projectName && (
                <span className="max-w-[100px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-[var(--text-muted)]">
                  {projectName}
                </span>
              )}
              {getCompactActivityIndicator()}
            </>
          )}
        </Link>
      )}

      {provider && (
        <SessionMenu
          sessionId={sessionId}
          projectId={projectId}
          isStarred={isStarred ?? false}
          isArchived={isArchived ?? false}
          hasUnread={hasUnread ?? false}
          provider={provider}
          onToggleStar={handleToggleStar}
          onToggleArchive={handleToggleArchive}
          onToggleRead={handleToggleRead}
          onRename={() => {
            setRenameValue(displayTitle);
            setIsEditing(true);
          }}
          onClone={(newSessionId) => {
            navigate(
              `${basePath}/projects/${projectId}/sessions/${newSessionId}`,
            );
          }}
          useEllipsisIcon
          useFixedPositioning
          className={`absolute z-[2] flex shrink-0 items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [&.is-open]:opacity-100 ${
            mode === "compact"
              ? "right-0 top-1/2 -translate-y-1/2 pl-4 pr-2"
              : "right-2 top-3"
          }`}
          style={{
            background:
              mode === "compact"
                ? "linear-gradient(to right, transparent, var(--bg-surface) 60%)"
                : undefined,
          }}
        />
      )}
    </li>
  );
}
