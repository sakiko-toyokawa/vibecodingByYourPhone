import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { FileViewer } from "../components/FileViewer";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { buildEditorPath } from "../lib/editorNavigation";

/**
 * FilePage - Standalone page for viewing files.
 * Route: /projects/:projectId/file?path=<path>
 */
export function FilePage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams] = useSearchParams();
  const filePath = searchParams.get("path");

  if (!projectId) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-[var(--bg-surface)]">
        <div className="text-center text-[var(--text-muted)]">
          <h1 className="m-0 mb-4 text-xl text-[var(--text-primary)]">
            {t("fileInvalidUrl" as never)}
          </h1>
          <p>{t("fileMissingProjectId" as never)}</p>
          <Link
            to={`${basePath}/projects`}
            className="inline-flex items-center gap-2 rounded p-1 [font-size:var(--font-size-base)] text-[var(--link-color)] no-underline transition-colors hover:bg-[var(--bg-hover)]"
          >
            {t("fileGoToProjects" as never)}
          </Link>
        </div>
      </div>
    );
  }

  if (!filePath) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-[var(--bg-surface)]">
        <div className="text-center text-[var(--text-muted)]">
          <h1 className="m-0 mb-4 text-xl text-[var(--text-primary)]">
            {t("fileInvalidUrl" as never)}
          </h1>
          <p>{t("fileMissingPath" as never)}</p>
          <Link
            to={`${basePath}/projects/${projectId}`}
            className="inline-flex items-center gap-2 rounded p-1 [font-size:var(--font-size-base)] text-[var(--link-color)] no-underline transition-colors hover:bg-[var(--bg-hover)]"
          >
            {t("fileGoToProject" as never)}
          </Link>
        </div>
      </div>
    );
  }

  const editorPath = buildEditorPath({
    basePath,
    projectId,
    filePath,
  });

  return (
    <div className="flex flex-col h-screen bg-[var(--bg-surface)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-6 py-4">
        <Link
          to={`${basePath}/projects/${projectId}`}
          className="inline-flex items-center gap-2 rounded p-1 [font-size:var(--font-size-base)] text-[var(--link-color)] no-underline transition-colors hover:bg-[var(--bg-hover)]"
          title={t("fileBackToProject" as never)}
        >
          <BackIcon />
          <span>{t("fileBackToProject" as never)}</span>
        </Link>
        {editorPath && (
          <button
            type="button"
            className="inline-flex items-center rounded-sm border border-[var(--outline-variant)] bg-[var(--surface-container-lowest)] px-3 py-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--on-surface)] transition-colors hover:bg-[var(--surface-container-high)]"
            onClick={() => navigate(editorPath)}
          >
            Open in Editor
          </button>
        )}
      </div>
      <div className="flex-1 overflow-hidden">
        <FileViewer projectId={projectId} filePath={filePath} standalone />
      </div>
    </div>
  );
}

function BackIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 12L6 8l4-4" />
    </svg>
  );
}
