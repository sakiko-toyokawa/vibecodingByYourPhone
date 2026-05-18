import type { ReactNode } from "react";
import { useI18n } from "../i18n";
import { truncateText } from "../lib/text";
import { ThemeToggle } from "./ThemeToggle";

interface PageHeaderProps {
  title: string;
  /** Optional custom element to render instead of the default title */
  titleElement?: ReactNode;
  /** Mobile: opens the sidebar overlay */
  onOpenSidebar?: () => void;
  /** Desktop: toggles sidebar expanded/collapsed */
  onToggleSidebar?: () => void;
  /** Whether we're in desktop mode (wide screen) */
  isWideScreen?: boolean;
  /** Whether the sidebar is currently collapsed (desktop only) */
  isSidebarCollapsed?: boolean;
  /** Show a back button instead of sidebar toggle */
  showBack?: boolean;
  /** Callback when back button is clicked */
  onBack?: () => void;
  /** Optional content to render on the right side of the header */
  rightContent?: ReactNode;
}

export function PageHeader({
  title,
  titleElement,
  onOpenSidebar,
  onToggleSidebar,
  isWideScreen = false,
  isSidebarCollapsed = false,
  showBack = false,
  onBack,
  rightContent,
}: PageHeaderProps) {
  const { t } = useI18n();
  const handleToggle = isWideScreen
    ? isSidebarCollapsed
      ? undefined
      : onToggleSidebar
    : onOpenSidebar;
  const toggleTitle = isWideScreen
    ? t("actionToggleSidebar")
    : t("actionOpenSidebar");

  return (
    <header className="relative z-10 shrink-0 border-b border-[var(--outline-variant)] bg-[var(--surface)] pt-[env(safe-area-inset-top,0px)]">
      <div className="flex min-h-[64px] items-center justify-between px-6 py-4 pl-1 [font-family:var(--font-body)]">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {showBack && onBack ? (
            <button
              type="button"
              className="flex shrink-0 items-center justify-center rounded-sm bg-transparent p-1 text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--surface-container-high)] hover:text-[var(--text-primary)]"
              onClick={onBack}
              title={t("actionBack")}
              aria-label={t("actionBack")}
            >
              <span className="text-sm font-medium">←</span>
            </button>
          ) : (
            handleToggle && (
              <button
                type="button"
                className="flex shrink-0 items-center justify-center rounded-sm bg-transparent p-1 text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--surface-container-high)] hover:text-[var(--text-primary)]"
                onClick={handleToggle}
                title={toggleTitle}
                aria-label={toggleTitle}
              >
                <span className="text-sm font-medium">☰</span>
              </button>
            )
          )}
          {titleElement ?? (
            <h1
              className="max-w-[calc(100vw-150px)] cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap text-xl font-medium text-[var(--text-primary)] hover:text-[var(--text-secondary)] md:text-2xl"
              style={{ fontFamily: "var(--font-display)" }}
              title={title.length > 60 ? title : undefined}
            >
              {truncateText(title)}
            </h1>
          )}
        </div>
        <div className="ml-4 flex shrink-0 items-center gap-3">
          <ThemeToggle />
          {rightContent}
        </div>
      </div>
    </header>
  );
}
