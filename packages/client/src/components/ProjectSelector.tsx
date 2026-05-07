import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useProjects } from "../hooks/useProjects";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import type { Project } from "../types";

const DESKTOP_BREAKPOINT = 769;

interface ProjectSelectorProps {
  /** Currently selected project ID */
  currentProjectId: string;
  /** Current project name (for display before projects load) */
  currentProjectName?: string;
  /** Called when a new project is selected */
  onProjectChange?: (project: Project) => void;
}

/**
 * A dropdown selector for choosing which project to create a session in.
 * Shows as a clickable title that opens a dropdown (desktop) or bottom sheet (mobile).
 */
export function ProjectSelector({
  currentProjectId,
  currentProjectName,
  onProjectChange,
}: ProjectSelectorProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(
    () => window.innerWidth >= DESKTOP_BREAKPOINT,
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();

  const { projects, loading } = useProjects();

  // Find current project name
  const currentProject = projects.find((p) => p.id === currentProjectId);
  const displayName =
    currentProject?.name ?? currentProjectName ?? t("projectSelectorFallback");

  const handleButtonClick = () => {
    buttonRef.current?.blur();
    setIsOpen(true);
  };

  const handleProjectSelect = (project: Project) => {
    if (project.id !== currentProjectId) {
      // If a callback is provided, use it (allows parent to handle URL updates)
      // Otherwise navigate to the new project's new-session page
      if (onProjectChange) {
        onProjectChange(project);
      } else {
        navigate(
          `${basePath}/new-session?projectId=${encodeURIComponent(project.id)}`,
        );
      }
    }
    setIsOpen(false);
  };

  const handleClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  // Track desktop vs mobile
  useEffect(() => {
    const handleResize = () => {
      setIsDesktop(window.innerWidth >= DESKTOP_BREAKPOINT);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Close on Escape
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

  // Close on click outside (desktop)
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

  // Lock body scroll on mobile when open
  useEffect(() => {
    if (isOpen && !isDesktop) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [isOpen, isDesktop]);

  // Focus sheet when opened
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

  // Don't show selector if only one project
  if (!loading && projects.length <= 1) {
    return (
      <span className="max-w-[calc(100vw-150px)] overflow-hidden text-ellipsis whitespace-nowrap font-medium text-[var(--text-primary)]">
        {displayName}
      </span>
    );
  }

  const optionsContent = (
    <div className="max-h-[320px] overflow-y-auto">
      {projects.map((project) => {
        const isSelected = project.id === currentProjectId;
        return (
          <button
            key={project.id}
            type="button"
            className={`flex w-full flex-col items-start bg-transparent px-3 py-2 text-left transition-colors duration-150 hover:bg-[var(--bg-hover)] ${isSelected ? "bg-[var(--bg-active)]" : ""}`}
            onClick={() => handleProjectSelect(project)}
          >
            <span className="text-sm font-medium text-[var(--text-primary)]">
              {project.name}
            </span>
            <span className="text-[10px] text-[var(--text-muted)]">
              {t("projectSelectorSessionsCount", {
                count: project.sessionCount,
              })}
            </span>
          </button>
        );
      })}
    </div>
  );

  const mobileSheet =
    isOpen && !isDesktop
      ? createPortal(
          // biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handled globally
          <div
            className="fixed inset-0 z-[1000] flex items-end justify-center bg-black/50"
            onClick={handleOverlayClick}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div
              ref={sheetRef}
              className="flex w-full max-h-[70vh] flex-col overflow-hidden rounded-t-lg bg-[var(--bg-surface)] animate-[slideUp_0.2s_ease-out] pb-[env(safe-area-inset-bottom,0px)]"
              tabIndex={-1}
              aria-label={t("projectSelectorSelectProject")}
            >
              <div className="px-4 py-3 border-b border-[var(--border-color)]">
                <span className="text-[13px] font-semibold text-[var(--text-primary)]">
                  {t("projectSelectorSelectProject")}
                </span>
              </div>
              <div className="flex-1 overflow-y-auto py-2">
                {projects.map((project) => {
                  const isSelected = project.id === currentProjectId;
                  return (
                    <button
                      key={project.id}
                      type="button"
                      className={`flex w-full flex-col items-start bg-transparent px-4 py-3 text-left transition-colors duration-150 hover:bg-[var(--bg-hover)] ${isSelected ? "bg-[var(--bg-active)]" : ""}`}
                      onClick={() => handleProjectSelect(project)}
                    >
                      <span className="text-sm font-medium text-[var(--text-primary)]">
                        {project.name}
                      </span>
                      <span className="text-[10px] text-[var(--text-muted)]">
                        {t("projectSelectorSessionsCount", {
                          count: project.sessionCount,
                        })}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  const desktopDropdown =
    isOpen && isDesktop ? (
      <div
        ref={sheetRef}
        className="absolute left-0 top-[calc(100%+4px)] z-[100] min-w-[480px] max-w-[800px] overflow-hidden rounded-md border border-[var(--border-color)] bg-[var(--bg-surface)] shadow-lg"
        tabIndex={-1}
        aria-label={t("projectSelectorSelectProject")}
      >
        {optionsContent}
      </div>
    ) : null;

  return (
    <div className="relative inline-flex min-w-0 shrink-0">
      <button
        ref={buttonRef}
        type="button"
        className="inline-flex items-center gap-1 rounded-md bg-transparent px-2 py-1 -mx-2 -my-1 font-medium text-[var(--text-primary)] transition-colors duration-150 hover:bg-[var(--bg-hover)]"
        onClick={handleButtonClick}
        title={t("projectSelectorChangeProject")}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="whitespace-nowrap max-w-[calc(100vw-150px)] overflow-hidden text-ellipsis">
          {displayName}
        </span>
        <span
          className={`shrink-0 text-sm transition-transform duration-150 ${isOpen ? "rotate-180" : ""}`}
        >
          ▼
        </span>
      </button>
      {desktopDropdown}
      {mobileSheet}
    </div>
  );
}
