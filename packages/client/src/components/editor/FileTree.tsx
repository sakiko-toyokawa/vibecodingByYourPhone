import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorTreeEntry } from "../../api/client";
import { api } from "../../api/client";

interface FileTreeProps {
  projectId: string;
  currentFilePath?: string | null;
  onFileSelect: (path: string) => void;
  className?: string;
  headerAction?: ReactNode;
  hideHeader?: boolean;
}

function joinRelativePath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

function getParentPath(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash === -1 ? "" : path.slice(0, lastSlash);
}

function getAncestorPaths(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const paths: string[] = [];
  let current = "";

  for (let i = 0; i < parts.length - 1; i++) {
    current = joinRelativePath(current, parts[i] ?? "");
    paths.push(current);
  }

  return paths;
}

function FileIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 1.75h3.5L10.75 5v7.25H4z" />
      <path d="M7.5 1.75V5h3.25" />
    </svg>
  );
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {open ? (
        <>
          <path d="M1.75 5.25h10.5l-1 5.5H2.75z" />
          <path d="M1.75 5.25V3.5h3l1 1h5.5" />
        </>
      ) : (
        <>
          <path d="M1.75 3.5h3l1 1h6.5v6h-10.5z" />
        </>
      )}
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`}
    >
      <path d="M4.5 2.5L8 6 4.5 9.5" />
    </svg>
  );
}

export function FileTree({
  projectId,
  currentFilePath,
  onFileSelect,
  className,
  headerAction,
  hideHeader = false,
}: FileTreeProps) {
  const requestVersionRef = useRef(0);
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({
    "": true,
  });
  const [entriesByPath, setEntriesByPath] = useState<
    Record<string, EditorTreeEntry[]>
  >({});
  const [loadingPaths, setLoadingPaths] = useState<Record<string, boolean>>({});
  const [errorsByPath, setErrorsByPath] = useState<Record<string, string>>({});
  const loadingPathsRef = useRef<Record<string, boolean>>({});

  const loadDirectory = useCallback(
    async (path: string, requestVersion = requestVersionRef.current) => {
      if (loadingPathsRef.current[path]) return;

      loadingPathsRef.current[path] = true;
      setLoadingPaths((prev) => ({ ...prev, [path]: true }));
      setErrorsByPath((prev) => {
        const next = { ...prev };
        delete next[path];
        return next;
      });

      try {
        const data = await api.getEditorTree(projectId, path);
        if (requestVersion !== requestVersionRef.current) {
          return;
        }
        setEntriesByPath((prev) => ({ ...prev, [path]: data.entries }));
      } catch (error) {
        if (requestVersion !== requestVersionRef.current) {
          return;
        }
        setErrorsByPath((prev) => ({
          ...prev,
          [path]:
            error instanceof Error ? error.message : "Failed to load directory",
        }));
      } finally {
        delete loadingPathsRef.current[path];
        if (requestVersion === requestVersionRef.current) {
          setLoadingPaths((prev) => {
            const next = { ...prev };
            delete next[path];
            return next;
          });
        }
      }
    },
    [projectId],
  );

  useEffect(() => {
    requestVersionRef.current += 1;
    loadingPathsRef.current = {};
    setExpandedPaths({ "": true });
    setEntriesByPath({});
    setLoadingPaths({});
    setErrorsByPath({});
    void loadDirectory("", requestVersionRef.current);
  }, [loadDirectory]);

  useEffect(() => {
    if (!currentFilePath) return;

    const ancestorPaths = getAncestorPaths(currentFilePath);
    if (ancestorPaths.length === 0) return;

    setExpandedPaths((prev) => {
      const next = { ...prev };
      for (const path of ancestorPaths) {
        next[path] = true;
      }
      return next;
    });

    void (async () => {
      const requestVersion = requestVersionRef.current;
      for (const path of ancestorPaths) {
        if (!entriesByPath[path]) {
          await loadDirectory(path, requestVersion);
        }
      }
    })();
  }, [currentFilePath, entriesByPath, loadDirectory]);

  function toggleDirectory(path: string) {
    const isOpen = !!expandedPaths[path];
    if (isOpen) {
      setExpandedPaths((prev) => ({ ...prev, [path]: false }));
      return;
    }

    setExpandedPaths((prev) => ({ ...prev, [path]: true }));
    if (!entriesByPath[path]) {
      void loadDirectory(path);
    }
  }

  function renderDirectory(path: string, depth: number) {
    const entries = entriesByPath[path] ?? [];
    const isLoading = !!loadingPaths[path];
    const error = errorsByPath[path];

    return (
      <div key={path || "__root"}>
        {entries.map((entry) => {
          const isDirectory = entry.type === "directory";
          const isOpen = !!expandedPaths[entry.path];
          const isActive = currentFilePath === entry.path;
          const isAncestor =
            !!currentFilePath &&
            getParentPath(currentFilePath).startsWith(`${entry.path}/`);

          return (
            <div key={entry.path}>
              <button
                type="button"
                onClick={() =>
                  isDirectory
                    ? toggleDirectory(entry.path)
                    : onFileSelect(entry.path)
                }
                className={[
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors",
                  isActive
                    ? "bg-[var(--primary)] text-[var(--on-primary)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
                ].join(" ")}
                style={{ paddingLeft: `${depth * 14 + 8}px` }}
              >
                <span className="flex h-4 w-4 items-center justify-center text-[var(--text-dimmed)]">
                  {isDirectory ? (
                    <ChevronIcon open={isOpen} />
                  ) : (
                    <span className="block h-3 w-3" />
                  )}
                </span>
                <span
                  className={`flex h-4 w-4 items-center justify-center ${isActive ? "text-white" : isAncestor ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}`}
                >
                  {isDirectory ? <FolderIcon open={isOpen} /> : <FileIcon />}
                </span>
                <span className="min-w-0 truncate">{entry.name}</span>
              </button>

              {isDirectory && isOpen && renderDirectory(entry.path, depth + 1)}
            </div>
          );
        })}

        {isLoading && (
          <div
            className="px-2 py-1 text-xs text-[var(--text-muted)]"
            style={{ paddingLeft: `${depth * 14 + 28}px` }}
          >
            Loading...
          </div>
        )}

        {error && (
          <div
            className="rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--error-color)]"
            style={{ marginLeft: `${depth * 14 + 8}px` }}
          >
            {error}
          </div>
        )}
      </div>
    );
  }

  return (
    <aside
      className={[
        "flex h-full min-h-0 flex-col border-r border-[var(--outline-variant)] bg-[var(--surface-container-low)] [font-family:var(--font-body)]",
        className ?? "",
      ].join(" ")}
    >
      {!hideHeader && (
        <div className="flex items-center justify-between border-b border-[var(--outline-variant)] px-3 py-2">
          <div className="text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--text-muted)]">
            Files
          </div>
          {headerAction}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {renderDirectory("", 0)}
      </div>
    </aside>
  );
}
