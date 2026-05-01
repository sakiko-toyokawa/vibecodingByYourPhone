import type { GitFileChange } from "@yep-anywhere/shared";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { ProjectSelector } from "../components/ProjectSelector";
import { Modal } from "../components/ui/Modal";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useGitStatus } from "../hooks/useGitStatus";
import { useProject, useProjects } from "../hooks/useProjects";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";

interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface GitDiffResult {
  diffHtml: string;
  structuredPatch: PatchHunk[];
  markdownHtml?: string;
}

export function GitStatusPage() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get("projectId");
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();

  const { projects, loading: projectsLoading } = useProjects();
  const effectiveProjectId = projectId || projects[0]?.id;
  const { project } = useProject(effectiveProjectId);
  const { gitStatus, loading, error } = useGitStatus(effectiveProjectId);

  useDocumentTitle(project?.name, t("gitStatusTitle"));

  const handleProjectChange = (newProjectId: string) => {
    setSearchParams({ projectId: newProjectId }, { replace: true });
  };

  if (!effectiveProjectId && !projectsLoading && projects.length === 0) {
    return (
      <div className="text-[var(--error-color)] p-2 bg-[var(--bg-error,rgba(207,34,46,0.1))] rounded">
        {t("gitStatusNoProjects")}
      </div>
    );
  }

  const wrapperClass = isWideScreen
    ? "flex justify-center min-w-0 h-[100dvh] overflow-hidden"
    : "flex-1 flex flex-col min-h-0";
  const innerClass = isWideScreen
    ? "w-full flex flex-col h-[100dvh]"
    : "flex-1 flex flex-col min-h-0";

  return (
    <div className={wrapperClass}>
      <div className={innerClass}>
        <PageHeader
          title={project?.name ?? t("gitStatusTitle")}
          titleElement={
            effectiveProjectId ? (
              <ProjectSelector
                currentProjectId={effectiveProjectId}
                currentProjectName={project?.name}
                onProjectChange={(p) => handleProjectChange(p.id)}
              />
            ) : undefined
          }
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
        />

        <main className="flex-1 overflow-y-auto min-h-0">
          <div className="px-6 py-8 md:px-10 md:py-10">
            {loading || projectsLoading ? (
              <div className="text-[var(--text-muted)] italic [font-size:var(--font-size-lg)]">
                {t("gitStatusLoading")}
              </div>
            ) : error ? (
              <div className="text-[var(--error-color)] p-2 bg-[var(--bg-error,rgba(207,34,46,0.1))] rounded">
                {t("gitStatusErrorPrefix")} {error.message}
              </div>
            ) : gitStatus && !gitStatus.isGitRepo ? (
              <div className="text-[var(--text-muted)] italic p-4 text-center">
                {t("gitStatusNotRepo")}
              </div>
            ) : gitStatus && effectiveProjectId ? (
              <GitStatusContent
                status={gitStatus}
                projectId={effectiveProjectId}
                t={t as never}
              />
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}

function GitStatusContent({
  status,
  projectId,
  t,
}: {
  status: import("@yep-anywhere/shared").GitStatusInfo;
  projectId: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [selectedFile, setSelectedFile] = useState<GitFileChange | null>(null);

  const stagedFiles = status.files.filter((f) => f.staged);
  const unstagedFiles = status.files.filter(
    (f) => !f.staged && f.status !== "?",
  );
  const untrackedFiles = status.files.filter((f) => f.status === "?");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 flex-wrap text-[0.95rem] p-3 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-[var(--radius-md)]">
        <span className="flex items-center text-[var(--text-muted)]">
          {"\u2387"}
        </span>
        <span className="font-semibold text-[var(--text-primary)]">
          {status.branch ?? t("gitStatusDetachedHead")}
        </span>
        {status.upstream && (
          <span className="text-[var(--text-muted)] text-[0.85rem]">
            {" "}
            → {status.upstream}
          </span>
        )}
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="text-[var(--warning-color)] text-[0.85rem] font-medium">
            {status.ahead > 0 && ` ↑${status.ahead}`}
            {status.behind > 0 && ` ↓${status.behind}`}
          </span>
        )}
        <span
          className={`ml-auto text-[0.75rem] font-semibold px-2 py-0.5 rounded-[var(--radius-full,999px)] uppercase tracking-wide ${status.isClean ? "bg-[color-mix(in_srgb,var(--success-color)_20%,transparent)] text-[var(--success-color)]" : "bg-[color-mix(in_srgb,var(--warning-color)_20%,transparent)] text-[var(--warning-color)]"}`}
        >
          {status.isClean ? t("gitStatusClean") : t("gitStatusDirty")}
        </span>
      </div>

      {status.isClean ? (
        <div className="text-[var(--text-muted)] italic p-4 text-center">
          {t("gitStatusWorkingTreeClean")}
        </div>
      ) : (
        <>
          {stagedFiles.length > 0 && (
            <GitFileSection
              title={t("gitStatusStaged")}
              files={stagedFiles}
              onFileClick={setSelectedFile}
            />
          )}
          {unstagedFiles.length > 0 && (
            <GitFileSection
              title={t("gitStatusChanges")}
              files={unstagedFiles}
              onFileClick={setSelectedFile}
            />
          )}
          {untrackedFiles.length > 0 && (
            <GitFileSection
              title={t("gitStatusUntracked")}
              files={untrackedFiles}
              onFileClick={setSelectedFile}
            />
          )}
        </>
      )}

      {selectedFile && (
        <GitDiffModal
          file={selectedFile}
          projectId={projectId}
          t={t}
          onClose={() => setSelectedFile(null)}
        />
      )}
    </div>
  );
}

function GitFileSection({
  title,
  files,
  onFileClick,
}: {
  title: string;
  files: GitFileChange[];
  onFileClick: (file: GitFileChange) => void;
}) {
  return (
    <div className="flex flex-col">
      <h3 className="text-[0.85rem] font-semibold text-[var(--text-muted)] uppercase tracking-wide m-0 mb-2">
        {title} <span className="font-normal">({files.length})</span>
      </h3>
      <ul className="list-none m-0 p-0 flex flex-col">
        {files.map((file) => (
          <GitFileItem
            key={`${file.path}-${file.staged}`}
            file={file}
            onClick={onFileClick}
          />
        ))}
      </ul>
    </div>
  );
}

function GitFileItem({
  file,
  onClick,
}: {
  file: GitFileChange;
  onClick: (file: GitFileChange) => void;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard nav not needed for file list
    <li
      className="flex items-center gap-2 py-2 px-3 border-b border-[var(--border-color)] text-[0.85rem] min-w-0 cursor-pointer transition-colors hover:bg-[var(--bg-hover)] active:bg-[var(--bg-active)] last:border-b-0"
      onClick={() => onClick(file)}
    >
      <span
        className={`flex-shrink-0 w-5 h-5 flex items-center justify-center text-[0.7rem] font-bold rounded-[var(--radius-sm)] uppercase ${getGitStatusClass(file.status)}`}
      >
        {file.status}
      </span>
      <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--text-primary)] font-mono text-[0.8rem]">
        {file.origPath ? (
          <>
            {file.origPath} → {file.path}
          </>
        ) : (
          file.path
        )}
      </span>
      {(file.linesAdded !== null || file.linesDeleted !== null) && (
        <span className="flex-shrink-0 flex gap-2 font-mono text-[0.75rem]">
          {file.linesAdded !== null && (
            <span className="text-[var(--success-color)]">
              +{file.linesAdded}
            </span>
          )}
          {file.linesDeleted !== null && (
            <span className="text-[var(--error-color)]">
              -{file.linesDeleted}
            </span>
          )}
        </span>
      )}
    </li>
  );
}

function getGitStatusClass(status: string): string {
  switch (status.toLowerCase()) {
    case "m":
      return "bg-[color-mix(in_srgb,var(--warning-color)_20%,transparent)] text-[var(--warning-color)]";
    case "a":
      return "bg-[color-mix(in_srgb,var(--success-color)_20%,transparent)] text-[var(--success-color)]";
    case "d":
      return "bg-[color-mix(in_srgb,var(--error-color)_20%,transparent)] text-[var(--error-color)]";
    case "r":
      return "bg-[color-mix(in_srgb,var(--accent-color)_20%,transparent)] text-[var(--accent-color)]";
    case "?":
      return "text-[var(--text-muted)] bg-[color-mix(in_srgb,var(--text-muted)_15%,transparent)]";
    case "u":
      return "bg-[color-mix(in_srgb,var(--error-color)_20%,transparent)] text-[var(--error-color)]";
    case "t":
      return "bg-[color-mix(in_srgb,var(--accent-color)_20%,transparent)] text-[var(--accent-color)]";
    default:
      return "bg-[var(--bg-secondary)] text-[var(--text-muted)]";
  }
}

function GitDiffModal({
  file,
  projectId,
  t,
  onClose,
}: {
  file: GitFileChange;
  projectId: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onClose: () => void;
}) {
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .getGitDiff(projectId, {
        path: file.path,
        staged: file.staged,
        status: file.status,
      })
      .then((result) => {
        if (!cancelled) {
          setDiffResult(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || t("gitStatusLoadDiffFailed"));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, file.path, file.staged, file.status, t]);

  const fileName = file.path.split("/").pop() || file.path;

  return (
    <Modal title={fileName} onClose={onClose}>
      {loading ? (
        <div className="p-4 text-center text-[var(--text-muted)]">
          {t("gitStatusLoadingDiff")}
        </div>
      ) : error ? (
        <div className="p-4 text-center text-[var(--error-color)]">{error}</div>
      ) : diffResult ? (
        <GitDiffModalContent
          file={file}
          projectId={projectId}
          diffResult={diffResult}
          t={t}
        />
      ) : null}
    </Modal>
  );
}

function GitDiffModalContent({
  file,
  projectId,
  diffResult,
  t,
}: {
  file: GitFileChange;
  projectId: string;
  diffResult: GitDiffResult;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [showFullContext, setShowFullContext] = useState(false);
  const [fullContextResult, setFullContextResult] =
    useState<GitDiffResult | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [showMarkdownPreview, setShowMarkdownPreview] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const isMarkdown = /\.(md|markdown)$/i.test(file.path);
  const hasMarkdownPreview =
    isMarkdown &&
    !!(fullContextResult?.markdownHtml || diffResult.markdownHtml);

  const handleToggleContext = useCallback(async () => {
    if (!showFullContext && !fullContextResult) {
      setContextLoading(true);
      setContextError(null);
      try {
        const result = await api.getGitDiff(projectId, {
          path: file.path,
          staged: file.staged,
          status: file.status,
          fullContext: true,
        });
        setFullContextResult(result);
      } catch (err) {
        setContextError(
          err instanceof Error ? err.message : t("gitStatusLoadContextFailed"),
        );
        setContextLoading(false);
        return;
      }
      setContextLoading(false);
    }
    setShowFullContext(!showFullContext);
  }, [
    showFullContext,
    fullContextResult,
    projectId,
    file.path,
    file.staged,
    file.status,
    t,
  ]);

  // Scroll to first changed line when showing full context
  useEffect(() => {
    if (showFullContext && fullContextResult && contentRef.current) {
      requestAnimationFrame(() => {
        const firstChange = contentRef.current?.querySelector(
          ".line-deleted, .line-inserted",
        );
        if (firstChange) {
          firstChange.scrollIntoView({ block: "center", behavior: "instant" });
        }
      });
    }
  }, [showFullContext, fullContextResult]);

  const displayResult =
    showFullContext && fullContextResult ? fullContextResult : diffResult;

  const markdownHtml =
    fullContextResult?.markdownHtml || diffResult.markdownHtml;

  return (
    <div className="bg-[var(--bg-code)] rounded overflow-auto" ref={contentRef}>
      <div className="flex gap-2 items-center mb-3 p-2 bg-[var(--bg-secondary)] border-b border-[var(--border-color)] sticky top-0 z-[1]">
        <span className="flex-1 font-mono [font-size:var(--font-size-sm)] text-[var(--text-secondary)] overflow-hidden text-ellipsis whitespace-nowrap">
          {file.path}
        </span>
        <div className="flex gap-1">
          {hasMarkdownPreview && (
            <button
              type="button"
              className={`px-3 py-1 [font-size:var(--font-size-base)] bg-[var(--bg-surface)] border border-[var(--border-color)] rounded cursor-pointer text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-60 disabled:cursor-wait ${showMarkdownPreview ? "bg-[var(--accent-color)] text-white" : ""}`}
              onClick={() => setShowMarkdownPreview(!showMarkdownPreview)}
            >
              {showMarkdownPreview ? t("gitStatusDiff") : t("gitStatusPreview")}
            </button>
          )}
          {!showMarkdownPreview && (
            <button
              type="button"
              className="px-3 py-1 [font-size:var(--font-size-base)] bg-[var(--bg-surface)] border border-[var(--border-color)] rounded cursor-pointer text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-60 disabled:cursor-wait"
              onClick={handleToggleContext}
              disabled={contextLoading}
            >
              {contextLoading
                ? t("gitStatusLoading")
                : showFullContext
                  ? t("gitStatusDiffOnly")
                  : t("gitStatusFullContext")}
            </button>
          )}
        </div>
        {contextError && (
          <span className="text-[var(--text-error)] [font-size:var(--font-size-sm)]">
            {contextError}
          </span>
        )}
      </div>

      {showMarkdownPreview && markdownHtml ? (
        <div className="overflow-auto">
          <div
            className="p-4 leading-relaxed text-[var(--text-primary)]"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
            dangerouslySetInnerHTML={{ __html: markdownHtml }}
          />
        </div>
      ) : displayResult.diffHtml ? (
        <HighlightedDiff diffHtml={displayResult.diffHtml} />
      ) : (
        <DiffLines
          lines={displayResult.structuredPatch.flatMap((h) => h.lines)}
        />
      )}
    </div>
  );
}

/** Render syntax-highlighted diff HTML from server */
const HighlightedDiff = memo(function HighlightedDiff({
  diffHtml,
}: {
  diffHtml: string;
}) {
  return (
    <div
      className="font-mono [font-size:var(--font-size-base)] leading-relaxed tab-[var(--tab-size)]"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is safe
      dangerouslySetInnerHTML={{ __html: diffHtml }}
    />
  );
});

/** Fallback plain-text diff renderer */
const DiffLines = memo(function DiffLines({ lines }: { lines: string[] }) {
  return (
    <div className="my-2 first:mt-0 rounded overflow-hidden border border-[var(--border-color)]">
      <pre className="m-0 p-0 bg-[var(--bg-code)] overflow-x-auto tab-[var(--tab-size)]">
        {lines.map((line, i) => {
          const prefix = line[0];
          const lineClass =
            prefix === "-"
              ? "bg-[var(--bg-diff-removed,rgba(207,34,46,0.15))] text-[var(--text-diff-removed,var(--error-color))]"
              : prefix === "+"
                ? "bg-[var(--bg-diff-added,rgba(26,127,55,0.15))] text-[var(--text-diff-added,var(--success-color))]"
                : "text-[var(--text-muted)]";
          return (
            <div
              key={`${i}-${line.slice(0, 50)}`}
              className={`px-2 leading-relaxed ${lineClass}`}
            >
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
});
