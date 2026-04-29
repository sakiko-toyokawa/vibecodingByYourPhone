import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { getProvider } from "../providers/registry";

export interface SessionMenuProps {
  sessionId: string;
  projectId: string;
  isStarred: boolean;
  isArchived: boolean;
  hasUnread?: boolean;
  /** Provider name - used for capability checks like cloning support */
  provider?: string;
  /** Process ID if session has an active process (enables terminate option) */
  processId?: string;
  onToggleStar: () => void | Promise<void>;
  onToggleArchive: () => void | Promise<void>;
  onToggleRead?: () => void | Promise<void>;
  onRename: () => void;
  /** Called after successful clone with the new session ID */
  onClone?: (newSessionId: string) => void | Promise<void>;
  /** Called to terminate the session's process */
  onTerminate?: () => void | Promise<void>;
  /** Use "..." icon instead of chevron */
  useEllipsisIcon?: boolean;
  /** Whether session sharing is configured */
  sharingConfigured?: boolean;
  /** Called to share the session as a snapshot */
  onShare?: () => void | Promise<void>;
  /** Additional class for the wrapper */
  className?: string;
  /** Use fixed positioning for dropdown (escapes overflow clipping) */
  useFixedPositioning?: boolean;
  /** Inline styles for the wrapper */
  style?: React.CSSProperties;
}

export function SessionMenu({
  sessionId,
  projectId,
  isStarred,
  isArchived,
  hasUnread,
  provider,
  processId,
  onToggleStar,
  onToggleArchive,
  onToggleRead,
  onRename,
  onClone,
  onTerminate,
  sharingConfigured,
  onShare,
  useEllipsisIcon = false,
  className = "",
  useFixedPositioning = false,
  style,
}: SessionMenuProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [isCloning, setIsCloning] = useState(false);
  const [isTerminating, setIsTerminating] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState<{
    top: number;
    left?: number;
    right?: number;
  } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside or scrolling (mobile)
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      // Check both wrapper and dropdown (dropdown may be in portal)
      const clickedInWrapper = wrapperRef.current?.contains(target);
      const clickedInDropdown = dropdownRef.current?.contains(target);
      if (!clickedInWrapper && !clickedInDropdown) {
        setIsOpen(false);
        triggerRef.current?.blur();
      }
    };
    const handleScroll = (e: Event) => {
      // Only close if scroll happens in an ancestor of the menu trigger
      // This prevents closing when unrelated areas (like main content pane) scroll
      const scrollTarget = e.target as Node;
      if (
        scrollTarget instanceof Node &&
        wrapperRef.current &&
        !scrollTarget.contains(wrapperRef.current)
      ) {
        return; // Scroll is not in an ancestor of the menu, ignore
      }
      setIsOpen(false);
      setDropdownPosition(null);
      triggerRef.current?.blur();
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("scroll", handleScroll, true);
    };
  }, [isOpen]);

  const handleToggleOpen = () => {
    if (isOpen) {
      setIsOpen(false);
      setDropdownPosition(null);
      triggerRef.current?.blur();
    } else {
      // Calculate position synchronously before opening to avoid flicker
      if (useFixedPositioning && triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        const dropdownWidth = 140; // Approximate width of dropdown
        const dropdownHeight = 180; // Approximate height of dropdown (varies by options)
        const rightPosition = window.innerWidth - rect.right;
        const margin = 8;

        // Check if dropdown would overflow bottom of viewport
        const wouldOverflowBottom =
          rect.bottom + margin + dropdownHeight > window.innerHeight;

        // Calculate vertical position - show above trigger if it would overflow bottom
        const top = wouldOverflowBottom
          ? rect.top - dropdownHeight - margin
          : rect.bottom + margin;

        // If right-aligned would overflow left edge, use left-aligned instead
        if (rect.right - dropdownWidth < margin) {
          setDropdownPosition({
            top,
            left: rect.left,
          });
        } else {
          setDropdownPosition({
            top,
            right: rightPosition,
          });
        }
      }
      setIsOpen(true);
    }
  };

  const handleAction = (action: () => void | Promise<void>) => {
    setIsOpen(false);
    setDropdownPosition(null);
    triggerRef.current?.blur();
    action();
  };

  const handleClone = async () => {
    if (isCloning) return;
    setIsCloning(true);
    setIsOpen(false);
    setDropdownPosition(null);
    triggerRef.current?.blur();
    try {
      const result = await api.cloneSession(
        projectId,
        sessionId,
        undefined,
        provider,
      );
      onClone?.(result.sessionId);
    } catch (error) {
      console.error("Failed to clone session:", error);
    } finally {
      setIsCloning(false);
    }
  };

  const handleTerminate = async () => {
    if (isTerminating || !onTerminate) return;
    setIsTerminating(true);
    setIsOpen(false);
    setDropdownPosition(null);
    triggerRef.current?.blur();
    try {
      await onTerminate();
    } catch (error) {
      console.error("Failed to terminate session:", error);
    } finally {
      setIsTerminating(false);
    }
  };

  const handleShare = async () => {
    if (isSharing || !onShare) return;
    setIsSharing(true);
    setIsOpen(false);
    setDropdownPosition(null);
    triggerRef.current?.blur();
    try {
      await onShare();
    } catch (error) {
      console.error("Failed to share session:", error);
    } finally {
      setIsSharing(false);
    }
  };

  const wrapperClasses = ["relative shrink-0", className, isOpen && "is-open"]
    .filter(Boolean)
    .join(" ");

  // For portal mode, we must have fixed positioning with calculated coordinates
  // Fall back to a visible position if calculation failed
  const dropdownStyle = useFixedPositioning
    ? {
        position: "fixed" as const,
        top: dropdownPosition?.top ?? 100,
        ...(dropdownPosition?.left !== undefined
          ? { left: dropdownPosition.left }
          : { right: dropdownPosition?.right ?? 20 }),
      }
    : undefined;

  const dropdownContent = (
    <div
      ref={dropdownRef}
      className={`${useFixedPositioning ? "" : "absolute right-0"} top-full z-[10000] mt-1 min-w-[140px] overflow-hidden rounded-md border border-[var(--border-color)] bg-[var(--bg-surface)] shadow-lg`}
      style={dropdownStyle}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 bg-transparent px-3 py-2 text-left text-xs text-[var(--text-primary)] transition-colors duration-150 hover:bg-[var(--bg-hover)]"
        onClick={() => handleAction(onToggleStar)}
      >
        <span className="shrink-0 text-[var(--text-muted)]">
          {isStarred ? "★" : "☆"}
        </span>
        {isStarred ? t("sessionMenuUnstar") : t("sessionMenuStar")}
      </button>
      <button
        type="button"
        className="flex w-full items-center gap-2 bg-transparent px-3 py-2 text-left text-xs text-[var(--text-primary)] transition-colors duration-150 hover:bg-[var(--bg-hover)]"
        onClick={() => handleAction(onRename)}
      >
        <span className="shrink-0 text-[var(--text-muted)]">✎</span>
        {t("sessionMenuRename")}
      </button>
      {onClone && getProvider(provider).capabilities.supportsCloning && (
        <button
          type="button"
          className="flex w-full items-center gap-2 bg-transparent px-3 py-2 text-left text-xs text-[var(--text-primary)] transition-colors duration-150 hover:bg-[var(--bg-hover)] disabled:opacity-50"
          onClick={handleClone}
          disabled={isCloning}
        >
          <span className="shrink-0 text-[var(--text-muted)]">⧉</span>
          {isCloning ? t("sessionMenuCloning") : t("sessionMenuClone")}
        </button>
      )}
      {sharingConfigured && onShare && (
        <button
          type="button"
          className="flex w-full items-center gap-2 bg-transparent px-3 py-2 text-left text-xs text-[var(--text-primary)] transition-colors duration-150 hover:bg-[var(--bg-hover)] disabled:opacity-50"
          onClick={handleShare}
          disabled={isSharing}
        >
          <span className="shrink-0 text-[var(--text-muted)]">↗</span>
          {isSharing ? t("sessionMenuSharing") : t("sessionMenuShare")}
        </button>
      )}
      <button
        type="button"
        className="flex w-full items-center gap-2 bg-transparent px-3 py-2 text-left text-xs text-[var(--text-primary)] transition-colors duration-150 hover:bg-[var(--bg-hover)]"
        onClick={() => handleAction(onToggleArchive)}
      >
        <span className="shrink-0 text-[var(--text-muted)]">🗃</span>
        {isArchived ? t("sessionMenuUnarchive") : t("sessionMenuArchive")}
      </button>
      {onToggleRead && (
        <button
          type="button"
          className="flex w-full items-center gap-2 bg-transparent px-3 py-2 text-left text-xs text-[var(--text-primary)] transition-colors duration-150 hover:bg-[var(--bg-hover)]"
          onClick={() => handleAction(onToggleRead)}
        >
          <span className="shrink-0 text-[var(--text-muted)]">
            {hasUnread ? "✓" : "●"}
          </span>
          {hasUnread ? t("sessionMenuMarkRead") : t("sessionMenuMarkUnread")}
        </button>
      )}
      {processId && onTerminate && (
        <button
          type="button"
          className="flex w-full items-center gap-2 bg-transparent px-3 py-2 text-left text-xs text-[var(--error-color)] transition-colors duration-150 hover:bg-red-50 disabled:opacity-50"
          onClick={handleTerminate}
          disabled={isTerminating}
        >
          <span className="shrink-0">✕</span>
          {isTerminating
            ? t("sessionMenuTerminating")
            : t("sessionMenuTerminate")}
        </button>
      )}
    </div>
  );

  // Render dropdown via portal when using fixed positioning to escape overflow clipping
  const renderDropdown = () => {
    if (useFixedPositioning) {
      return createPortal(dropdownContent, document.body);
    }
    return dropdownContent;
  };

  return (
    <div className={wrapperClasses} ref={wrapperRef} style={style}>
      <button
        ref={triggerRef}
        type="button"
        className="flex items-center justify-center rounded-sm bg-transparent p-1 text-[var(--text-muted)] opacity-60 transition-all duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] hover:opacity-100"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          handleToggleOpen();
        }}
        title={t("sessionMenuOptions")}
        aria-label={t("sessionMenuOptions")}
        aria-expanded={isOpen}
      >
        {useEllipsisIcon ? (
          <span className="text-sm font-medium">⋮</span>
        ) : (
          <span className="text-sm font-medium">▼</span>
        )}
      </button>
      {isOpen && renderDropdown()}
    </div>
  );
}
