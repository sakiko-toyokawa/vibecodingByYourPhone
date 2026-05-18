interface BuildEditorPathOptions {
  basePath?: string;
  projectId?: string | null;
  sessionId?: string | null;
  filePath?: string | null;
}

function normalizeBasePath(basePath = ""): string {
  if (!basePath || basePath === "/") {
    return "";
  }
  return basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
}

/**
 * Build the canonical editor route for a project, optionally scoped to a session
 * and preloading a file via the `path` query parameter.
 */
export function buildEditorPath({
  basePath = "",
  projectId,
  sessionId,
  filePath,
}: BuildEditorPathOptions): string | null {
  if (!projectId) {
    return null;
  }

  const prefix = normalizeBasePath(basePath);
  const editorPath = sessionId
    ? `${prefix}/projects/${projectId}/sessions/${sessionId}/editor`
    : `${prefix}/projects/${projectId}/editor`;

  if (!filePath) {
    return editorPath;
  }

  const params = new URLSearchParams({ path: filePath });
  return `${editorPath}?${params.toString()}`;
}
