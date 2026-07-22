import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { AiEditPanel } from "../components/editor/AiEditPanel";
import { CodeEditor } from "../components/editor/CodeEditor";
import { EditorToolbar } from "../components/editor/EditorToolbar";
import { FileTree } from "../components/editor/FileTree";
import { MobileFileTreeSheet } from "../components/editor/MobileFileTreeSheet";
import { useToastContext } from "../contexts/ToastContext";
import { useProject } from "../hooks/useProjects";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useNavigationLayout } from "../layouts";

const MAX_EDITABLE_FILE_SIZE = 1024 * 1024;

interface LoadedFileState {
  path: string;
  content: string;
  size: number;
}

function isPathTooLarge(size: number): boolean {
  return size > MAX_EDITABLE_FILE_SIZE;
}

export function CodeEditorPage() {
  const { showToast } = useToastContext();
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    project,
    loading: projectLoading,
    error: projectError,
  } = useProject(projectId);
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();

  const initialPath = searchParams.get("path");
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(
    initialPath,
  );
  const [savedContent, setSavedContent] = useState("");
  const [editorContent, setEditorContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [loadedFile, setLoadedFile] = useState<LoadedFileState | null>(null);
  const [showMobileTree, setShowMobileTree] = useState(false);
  const [draftPersistenceDegraded, setDraftPersistenceDegraded] =
    useState(false);

  const readOnly = useMemo(() => {
    if (!loadedFile) return false;
    return isPathTooLarge(loadedFile.size);
  }, [loadedFile]);

  useEffect(() => {
    setSelectedFilePath(initialPath);
  }, [initialPath]);

  useEffect(() => {
    if (!selectedFilePath) {
      setLoadedFile(null);
      setSavedContent("");
      setEditorContent("");
      setDirty(false);
      setFileError(null);
      return;
    }

    if (!projectId) return;

    let cancelled = false;
    setLoadingFile(true);
    setFileError(null);
    setSelectedText(null);
    setHasSelection(false);

    api
      .getFile(projectId, selectedFilePath, false, true)
      .then((response) => {
        if (cancelled) return;

        if (!response.content && response.metadata.isText) {
          throw new Error("File content is unavailable");
        }

        if (!response.metadata.isText) {
          throw new Error("Only text files can be edited");
        }

        const nextContent = response.content ?? "";
        setLoadedFile({
          path: selectedFilePath,
          content: nextContent,
          size: response.metadata.size,
        });
        setSavedContent(nextContent);
        setEditorContent(nextContent);
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadedFile(null);
        setSavedContent("");
        setEditorContent("");
        setFileError(
          error instanceof Error ? error.message : "Failed to load file",
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingFile(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, selectedFilePath]);

  const handleSave = useCallback(async () => {
    if (!projectId || !selectedFilePath || readOnly || !dirty || saving) return;

    setSaving(true);
    try {
      await api.writeProjectFile(projectId, selectedFilePath, editorContent);
      setSavedContent(editorContent);
      setLoadedFile((prev) =>
        prev
          ? {
              ...prev,
              content: editorContent,
            }
          : prev,
      );
      setDirty(false);
      showToast("File saved", "success");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to save file";
      showToast(message, "error");
    } finally {
      setSaving(false);
    }
  }, [
    dirty,
    editorContent,
    projectId,
    readOnly,
    saving,
    selectedFilePath,
    showToast,
  ]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "s"
      ) {
        return;
      }

      event.preventDefault();
      void handleSave();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSave]);

  function updatePathInUrl(path: string) {
    const next = new URLSearchParams(searchParams);
    next.set("path", path);
    setSearchParams(next, { replace: false });
  }

  function handleFileSelect(path: string) {
    setSelectedFilePath(path);
    updatePathInUrl(path);
    setShowMobileTree(false);
  }

  function handleOpenAiPanel() {
    if (!selectedFilePath || readOnly || !hasSelection) return;
    setAiPanelOpen(true);
  }

  function handleApplyAiEdit(nextContent: string) {
    setEditorContent(nextContent);
  }

  function handleBack() {
    if (projectId) {
      navigate(`${basePath}/sessions?project=${projectId}`);
      return;
    }
    navigate(`${basePath}/projects`);
  }

  const title = project?.name
    ? `${project.name} Editor`
    : projectLoading
      ? "Loading editor..."
      : "Code Editor";
  const mobileToolbarActions = !isWideScreen ? (
    <button
      type="button"
      className="inline-flex min-w-[5.5rem] flex-none items-center justify-center rounded-xl border border-[var(--border-color)] bg-[var(--bg-surface)] px-3 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)] sm:min-w-[7.5rem]"
      onClick={() => setShowMobileTree(true)}
    >
      Files
    </button>
  ) : null;

  if (!projectId) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg-surface)] px-4 text-center">
        <div>
          <div className="text-lg font-medium text-[var(--text-primary)]">
            Invalid editor URL
          </div>
          <Link
            to={`${basePath}/projects`}
            className="mt-4 inline-flex text-sm text-[var(--link-color)] no-underline"
          >
            Back to projects
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        isWideScreen
          ? "flex justify-center min-w-0 h-[100dvh] overflow-hidden"
          : "flex-1 flex flex-col min-h-0"
      }
    >
      <div
        className={
          isWideScreen
            ? "w-full flex flex-col h-[100dvh]"
            : "flex-1 flex flex-col min-h-0"
        }
      >
        <PageHeader
          title={title}
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
          showBack
          onBack={handleBack}
        />

        <main className="flex min-h-0 flex-1 overflow-hidden">
          {isWideScreen && (
            <div className="h-full w-[280px] shrink-0">
              <FileTree
                projectId={projectId}
                currentFilePath={selectedFilePath}
                onFileSelect={handleFileSelect}
              />
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col bg-[var(--bg-surface)]">
            <EditorToolbar
              filePath={selectedFilePath}
              dirty={dirty}
              saving={saving}
              readOnly={readOnly}
              draftPersistenceDegraded={draftPersistenceDegraded}
              hasSelection={hasSelection}
              auxiliaryActions={mobileToolbarActions}
              onSave={() => {
                void handleSave();
              }}
              onOpenAiEdit={handleOpenAiPanel}
            />

            <div className="min-h-0 flex-1">
              {projectError ? (
                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--error-color)]">
                  {projectError.message}
                </div>
              ) : fileError ? (
                <div className="flex h-full items-center justify-center px-6 text-center">
                  <div>
                    <div className="text-sm font-medium text-[var(--error-color)]">
                      {fileError}
                    </div>
                    <div className="mt-2 text-xs text-[var(--text-muted)]">
                      Pick another file from the tree.
                    </div>
                  </div>
                </div>
              ) : loadingFile ? (
                <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
                  Loading file...
                </div>
              ) : !selectedFilePath ? (
                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--text-muted)]">
                  Select a file to start editing.
                </div>
              ) : (
                <div className="flex h-full min-h-0 flex-col">
                  {readOnly && (
                    <div className="border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-2 text-xs text-[var(--text-muted)]">
                      Files over 1 MB open in read-only mode.
                    </div>
                  )}
                  <div className="min-h-0 flex-1">
                    <CodeEditor
                      projectId={projectId}
                      filePath={selectedFilePath}
                      value={editorContent}
                      savedValue={savedContent}
                      onChange={setEditorContent}
                      onDirtyChange={setDirty}
                      onSelectionChange={(text) => {
                        setSelectedText(text);
                        setHasSelection(!!text && text.trim().length > 0);
                      }}
                      onAiEditSelection={(text) => {
                        setSelectedText(text);
                        setHasSelection(text.trim().length > 0);
                        setAiPanelOpen(true);
                      }}
                      onDraftPersistenceUnavailable={() => {
                        setDraftPersistenceDegraded(true);
                        showToast(
                          "Draft autosave is unavailable in this browser session.",
                          "info",
                        );
                      }}
                      readOnly={readOnly}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </main>

        <MobileFileTreeSheet
          open={!isWideScreen && showMobileTree}
          onClose={() => setShowMobileTree(false)}
          title="Files"
        >
          <FileTree
            projectId={projectId}
            currentFilePath={selectedFilePath}
            onFileSelect={handleFileSelect}
            className="border-r-0"
            hideHeader
          />
        </MobileFileTreeSheet>

        {selectedFilePath && (
          <AiEditPanel
            projectId={projectId}
            filePath={selectedFilePath}
            content={editorContent}
            selectedText={selectedText}
            provider={project?.provider}
            open={aiPanelOpen}
            onApply={handleApplyAiEdit}
            onClose={() => setAiPanelOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
