import { Link, useNavigate } from "react-router-dom";
import { buildEditorPath } from "../lib/editorNavigation";
import { shortenPath } from "../lib/text";
import type { Project } from "../types";
import { ThinkingIndicator } from "./ThinkingIndicator";

interface ProjectCardProps {
  project: Project;
  /** Number of sessions needing approval/input in this project */
  needsAttentionCount: number;
  /** Number of sessions actively thinking (running, no pending input) */
  thinkingCount: number;
  /** Base path prefix for relay mode (e.g., "/remote/my-server") */
  basePath?: string;
}

/**
 * Format relative time for display
 */
function formatRelativeTime(timestamp: string): string {
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
}

/**
 * Card component for displaying a project in the projects list.
 * Matches visual style of SessionListItem card mode.
 */
export function ProjectCard({
  project,
  needsAttentionCount,
  thinkingCount,
  basePath = "",
}: ProjectCardProps) {
  const navigate = useNavigate();

  const handleNewSession = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigate(`${basePath}/new-session?projectId=${project.id}`);
  };

  const handleOpenEditor = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigate(
      buildEditorPath({
        basePath,
        projectId: project.id,
      }) ?? `${basePath}/projects`,
    );
  };

  return (
    <li className="project-card">
      <Link
        to={`${basePath}/sessions?project=${project.id}`}
        className="block p-6 bg-[var(--bg-surface)] border border-[var(--border-color)] rounded-[var(--radius-lg)] no-underline transition-colors duration-150 hover:bg-[var(--bg-hover)]"
      >
        <div className="flex items-start justify-between mb-3">
          <h3
            className="flex items-center gap-2 text-[var(--text-primary)] text-xl font-medium m-0"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {needsAttentionCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 bg-[var(--attention-color)] text-white rounded-full text-xs font-semibold">
                {needsAttentionCount}
              </span>
            )}
            {project.name}
          </h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-full border border-[var(--border-color)] bg-transparent px-3 py-1.5 text-xs font-medium text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              onClick={handleOpenEditor}
              title="Open editor"
            >
              Editor
            </button>
            <button
              type="button"
              className="flex items-center justify-center w-8 h-8 p-0 bg-transparent border border-[var(--border-color)] rounded-full text-[var(--text-muted)] cursor-pointer transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              onClick={handleNewSession}
              title="New session"
            >
              <span className="text-sm font-bold">+</span>
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span
            className="text-sm text-[var(--text-muted)] truncate"
            title={project.path}
          >
            {shortenPath(project.path)}
          </span>
          <span className="flex items-center gap-2 text-xs tracking-wide uppercase text-[var(--text-dimmed)]">
            <span>
              {project.sessionCount} session
              {project.sessionCount !== 1 ? "s" : ""}
            </span>
            {thinkingCount > 0 && (
              <span className="flex items-center gap-1">
                <ThinkingIndicator />
                <span>{thinkingCount}</span>
              </span>
            )}
            {project.lastActivity && (
              <>
                <span>·</span>
                <span>{formatRelativeTime(project.lastActivity)}</span>
              </>
            )}
          </span>
        </div>
      </Link>
    </li>
  );
}
