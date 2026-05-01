import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import type { PermissionMode } from "../types";

const MODE_ORDER: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

const MODE_LABELS: Record<PermissionMode, string> = {
  default: "Ask before edits",
  acceptEdits: "Edit automatically",
  plan: "Plan mode",
  bypassPermissions: "Bypass permissions",
};

const MODE_COLORS: Record<PermissionMode | "hold", string> = {
  default: "bg-[var(--timeline-dot-default)]",
  acceptEdits: "bg-[var(--success-color)]",
  plan: "bg-[var(--warning-color)]",
  bypassPermissions: "bg-[var(--error-color)]",
  hold: "bg-[var(--primary-color)]",
};

// Breakpoint for desktop behavior (should match CSS)
const DESKTOP_BREAKPOINT = 769;

interface ModeSelectorProps {
  mode: PermissionMode;
  onModeChange: (mode: PermissionMode) => void;
  disabled?: boolean;
  /** Whether the session is currently held (soft pause) */
  isHeld?: boolean;
  /** Callback when hold state changes */
  onHoldChange?: (held: boolean) => void;
}

/**
 * Mode selector button that opens a bottom sheet (mobile) or dropdown (desktop).
 * Includes hold (soft pause) as a special first option.
 * Clicking outside the popup or selecting a mode closes it.
 */
export function ModeSelector({
  mode,
  onModeChange,
  disabled,
  isHeld = false,
  onHoldChange,
}: ModeSelectorProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(
    () => window.innerWidth >= DESKTOP_BREAKPOINT,
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const handleButtonClick = () => {
    if (!disabled) {
      // Blur button to remove focus ring before sheet appears
      buttonRef.current?.blur();
      setIsOpen(true);
    }
  };

  const handleModeSelect = (selectedMode: PermissionMode) => {
    // If held, resume first
    if (isHeld && onHoldChange) {
      onHoldChange(false);
    }
    onModeChange(selectedMode);
    setIsOpen(false);
  };

  const handleHoldToggle = () => {
    if (onHoldChange) {
      onHoldChange(!isHeld);
    }
    setIsOpen(false);
  };

  const handleClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  // Track window resize to update desktop/mobile state
  useEffect(() => {
    const handleResize = () => {
      setIsDesktop(window.innerWidth >= DESKTOP_BREAKPOINT);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handleClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [isOpen, handleClose]);

  // Close on click outside (for desktop dropdown)
  useEffect(() => {
    if (!isOpen || !isDesktop) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        sheetRef.current &&
        !sheetRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        handleClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, isDesktop, handleClose]);

  // Prevent body scroll when sheet is open (mobile only)
  useEffect(() => {
    if (isOpen && !isDesktop) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [isOpen, isDesktop]);

  // Focus the sheet when opened for accessibility
  useEffect(() => {
    if (isOpen) {
      sheetRef.current?.focus();
    }
  }, [isOpen]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    // Only close if clicking directly on the overlay, not its children
    if (e.target === e.currentTarget) {
      e.preventDefault();
      e.stopPropagation();
      handleClose();
    }
  };

  // Display text: show "Hold" when held, otherwise show mode label
  const displayLabel = isHeld ? t("modeHold" as never) : MODE_LABELS[mode];
  const displayDotColor = isHeld ? MODE_COLORS.hold : MODE_COLORS[mode];

  // Shared options content used by both mobile sheet and desktop dropdown
  const optionsContent = (
    <>
      {/* Hold option - special first item */}
      {onHoldChange && (
        <button
          type="button"
          className={`flex items-center gap-3 px-4 py-3 bg-transparent border-none cursor-pointer text-left w-full transition-colors duration-150 hover:bg-[var(--bg-hover)] ${isHeld ? "bg-[rgba(217,119,87,0.08)]" : ""}`}
          onClick={handleHoldToggle}
          aria-pressed={isHeld}
        >
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${MODE_COLORS.hold}`}
          />
          <span className="flex-1 [font-size:var(--font-size-base)] text-[var(--text-primary)]">
            {isHeld ? t("modeResume" as never) : t("modeHold" as never)}
          </span>
          <span className="[font-size:var(--font-size-xs)] text-[var(--text-muted)] ml-auto mr-2">
            {isHeld
              ? t("modeContinueExecution" as never)
              : t("modePauseExecution" as never)}
          </span>
          {isHeld && (
            <span
              className="flex items-center text-[var(--accent-rust)]"
              aria-hidden="true"
            >
              &#x2713;
            </span>
          )}
        </button>
      )}

      {/* Divider between hold and permission modes */}
      {onHoldChange && (
        <div className="h-px bg-[var(--border-subtle)] my-2 mx-4" />
      )}

      {/* Permission mode options */}
      {MODE_ORDER.map((m) => (
        <button
          key={m}
          type="button"
          className={`flex items-center gap-3 px-4 py-3 bg-transparent border-none cursor-pointer text-left w-full transition-colors duration-150 hover:bg-[var(--bg-hover)] ${!isHeld && mode === m ? "bg-[rgba(217,119,87,0.08)]" : ""}`}
          onClick={() => handleModeSelect(m)}
          aria-pressed={!isHeld && mode === m}
        >
          <span className={`w-2 h-2 rounded-full shrink-0 ${MODE_COLORS[m]}`} />
          <span className="flex-1 [font-size:var(--font-size-base)] text-[var(--text-primary)]">
            {MODE_LABELS[m]}
          </span>
          {!isHeld && mode === m && (
            <span
              className="flex items-center text-[var(--accent-rust)]"
              aria-hidden="true"
            >
              &#x2713;
            </span>
          )}
        </button>
      ))}
    </>
  );

  // Mobile: bottom sheet with overlay (portaled)
  const mobileSheet =
    isOpen && !isDesktop
      ? createPortal(
          // biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handled globally
          <div
            className="fixed inset-0 bg-black/50 z-[10001] flex items-end justify-center md:hidden"
            onClick={handleOverlayClick}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div
              ref={sheetRef}
              className="bg-[var(--bg-surface)] rounded-t-[var(--radius-lg)] w-full max-w-[500px] max-h-[80vh] overflow-y-auto animate-[slideUp_0.2s_ease-out] shadow-[0_-2px_8px_rgba(0,0,0,0.08)] pb-[env(safe-area-inset-bottom,0)]"
              tabIndex={-1}
              aria-label={t("modeSelectLabel" as never)}
            >
              <div className="flex items-center justify-center px-4 py-3 border-b border-[var(--border-subtle)]">
                <span className="[font-size:var(--font-size-base)] font-semibold text-[var(--text-primary)]">
                  {t("modeSessionTitle" as never)}
                </span>
              </div>
              <div className="flex flex-col py-2">{optionsContent}</div>
            </div>
          </div>,
          document.body,
        )
      : null;

  // Desktop: dropdown positioned relative to button (inline)
  const desktopDropdown =
    isOpen && isDesktop ? (
      <div
        ref={sheetRef}
        className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-[var(--radius-lg)] min-w-[220px] shadow-[0_2px_6px_rgba(0,0,0,0.08)] z-[10001] animate-[dropdownFadeIn_0.15s_ease-out]"
        tabIndex={-1}
        aria-label={t("modeSelectLabel" as never)}
      >
        <div className="flex flex-col py-1">{optionsContent}</div>
      </div>
    ) : null;

  return (
    <div className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        className={`flex items-center gap-2 px-3 py-1 bg-transparent border border-[var(--border-color)] rounded-[var(--radius-md)] text-[var(--text-muted)] [font-size:var(--font-size-sm)] cursor-pointer hover:bg-[var(--bg-hover)] hover:border-[var(--border-input)] disabled:opacity-50 disabled:cursor-not-allowed ${isHeld ? "border-[var(--primary-color)]" : ""}`}
        onClick={handleButtonClick}
        disabled={disabled}
        title={t("modeClickToSelect" as never)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${displayDotColor}`} />
        {displayLabel}
      </button>
      {desktopDropdown}
      {mobileSheet}
    </div>
  );
}
