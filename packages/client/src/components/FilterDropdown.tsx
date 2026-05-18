import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";

// Breakpoint for desktop behavior (should match CSS)
const DESKTOP_BREAKPOINT = 769;

export interface FilterOption<T extends string> {
  value: T;
  label: string;
  description?: string; // Optional description shown below label
  count?: number;
  color?: string; // For provider colors (colored dot)
}

export interface FilterDropdownProps<T extends string> {
  label: string;
  options: FilterOption<T>[];
  selected: T[];
  onChange: (selected: T[]) => void;
  multiSelect?: boolean; // default true
  placeholder?: string; // shown when nothing selected
  align?: "left" | "right"; // dropdown alignment, default left
}

/**
 * Filter dropdown that opens a bottom sheet (mobile) or dropdown (desktop).
 * Supports multi-select with checkboxes and optional colored dots.
 * Clicking outside the popup or pressing Escape closes it.
 */
export function FilterDropdown<T extends string>({
  label,
  options,
  selected,
  onChange,
  multiSelect = true,
  placeholder,
  align = "left",
}: FilterDropdownProps<T>) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(
    () => window.innerWidth >= DESKTOP_BREAKPOINT,
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const handleButtonClick = () => {
    buttonRef.current?.blur();
    setIsOpen((prev) => !prev);
  };

  const handleOptionClick = (value: T) => {
    if (multiSelect) {
      if (selected.includes(value)) {
        onChange(selected.filter((v) => v !== value));
      } else {
        onChange([...selected, value]);
      }
    } else {
      // Single-select: toggle off if already selected, otherwise select
      if (selected.includes(value)) {
        onChange([]);
      } else {
        onChange([value]);
      }
      setIsOpen(false);
    }
  };

  const handleClearAll = () => {
    onChange([]);
  };

  const handleClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  useEffect(() => {
    const handleResize = () => {
      setIsDesktop(window.innerWidth >= DESKTOP_BREAKPOINT);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

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

  useEffect(() => {
    if (isOpen && !isDesktop) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [isOpen, isDesktop]);

  useEffect(() => {
    if (isOpen) {
      sheetRef.current?.focus();
    }
  }, [isOpen]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      e.preventDefault();
      e.stopPropagation();
      handleClose();
    }
  };

  // For single-select, show the selected option's label; for multi-select, show count
  const displayText = (() => {
    if (selected.length === 0) {
      return placeholder || label;
    }
    if (!multiSelect && selected.length === 1) {
      const selectedOption = options.find((o) => o.value === selected[0]);
      return selectedOption?.label || label;
    }
    return `${label} (${selected.length})`;
  })();

  const optionsContent = (
    <>
      {multiSelect && selected.length > 0 && (
        <>
          <button
            type="button"
            className="flex items-center gap-3 px-4 py-3 bg-transparent border-none cursor-pointer text-left w-full transition-colors duration-150 hover:bg-[var(--bg-hover)]"
            onClick={handleClearAll}
          >
            <span className="[font-size:var(--font-size-base)] text-[var(--text-muted)]">
              {t("filterClearAll")}
            </span>
          </button>
          <div className="h-px bg-[var(--border-subtle)] my-2 mx-4" />
        </>
      )}

      {options.map((option) => {
        const isSelected = selected.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            className={`flex items-center gap-3 px-4 py-3 bg-transparent border-none cursor-pointer text-left w-full transition-colors duration-150 hover:bg-[var(--bg-hover)] ${isSelected ? "bg-[rgba(217,119,87,0.08)]" : ""} ${!multiSelect ? "relative pr-8" : ""}`}
            onClick={() => handleOptionClick(option.value)}
            aria-pressed={isSelected}
          >
            {multiSelect && (
              <span
                className={`w-[18px] h-[18px] border-2 border-[var(--border-color)] rounded-[var(--radius-sm)] flex items-center justify-center shrink-0 transition-colors duration-150 ${isSelected ? "bg-[var(--text-primary)] border-[var(--text-primary)] text-white" : ""}`}
                aria-hidden="true"
              >
                {isSelected && <span className="text-xs">&#x2713;</span>}
              </span>
            )}

            {option.color && (
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: option.color }}
                aria-hidden="true"
              />
            )}

            <span className="flex-1 flex flex-col gap-0.5 min-w-0">
              <span className="[font-size:var(--font-size-base)] text-[var(--text-primary)]">
                {option.label}
              </span>
              {option.description && (
                <span className="[font-size:var(--font-size-xs)] text-[var(--text-muted)] leading-tight">
                  {option.description}
                </span>
              )}
            </span>

            {option.count !== undefined && (
              <span className="[font-size:var(--font-size-xs)] text-[var(--text-muted)] bg-[var(--bg-secondary)] px-2 py-1 rounded-[var(--radius-sm)]">
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </>
  );

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
              aria-label={t("filterByLabel", { label })}
            >
              <div className="flex items-center justify-center px-4 py-3 border-b border-[var(--border-subtle)]">
                <span className="[font-size:var(--font-size-base)] font-semibold text-[var(--text-primary)]">
                  {label}
                </span>
              </div>
              <div className="flex flex-col py-2">{optionsContent}</div>
            </div>
          </div>,
          document.body,
        )
      : null;

  const desktopDropdown =
    isOpen && isDesktop ? (
      <div
        ref={sheetRef}
        className={`absolute top-full mt-1 bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-[var(--radius-lg)] min-w-[200px] shadow-[0_2px_6px_rgba(0,0,0,0.08)] z-[10001] ${align === "right" ? "right-0" : "left-0"}`}
        tabIndex={-1}
        aria-label={t("filterByLabel", { label })}
      >
        <div className="flex flex-col py-1">{optionsContent}</div>
      </div>
    ) : null;

  return (
    <div className="relative inline-block max-w-full">
      <button
        ref={buttonRef}
        type="button"
        className={`flex w-full min-w-0 items-center gap-2 px-4 py-2 bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-lg [font-size:var(--font-size-sm)] text-[var(--text-primary)] cursor-pointer transition-colors duration-150 hover:border-[var(--border-color)] hover:bg-[var(--bg-secondary)] ${selected.length > 0 ? "border-[var(--text-primary)]/30 text-[var(--text-primary)] bg-[var(--bg-secondary)]" : ""}`}
        onClick={handleButtonClick}
        title={t("filterByLabel", { label })}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left">
          {displayText}
        </span>
        <svg
          className={`shrink-0 text-[var(--text-muted)] transition-transform duration-150 ${isOpen ? "rotate-180" : ""}`}
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {desktopDropdown}
      {mobileSheet}
    </div>
  );
}
