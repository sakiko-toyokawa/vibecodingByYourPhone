import { buildEditorPath } from "../lib/editorNavigation.js";

export function getFilePathLinkEditorPath({
  basePath,
  projectId,
  filePath,
  sessionId,
}: {
  basePath: string;
  projectId: string;
  filePath: string;
  sessionId?: string;
}): string | null {
  return buildEditorPath({
    basePath,
    projectId,
    sessionId,
    filePath,
  });
}

export function FilePathLinkModalFooter({
  editorPath,
  onOpen,
}: {
  editorPath: string | null;
  onOpen: () => void;
}) {
  if (!editorPath) {
    return null;
  }

  return (
    <div className="flex justify-end border-t border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2">
      <button
        type="button"
        className="inline-flex items-center rounded-sm border border-[var(--outline-variant)] bg-[var(--surface-container-lowest)] px-3 py-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--on-surface)] transition-colors hover:bg-[var(--surface-container-high)]"
        onClick={onOpen}
      >
        Open in Editor
      </button>
    </div>
  );
}
