import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { StreamingMarkdownProvider } from "../contexts/StreamingMarkdownContext";
import { useToastContext } from "../contexts/ToastContext";
import { useProject } from "../hooks/useProjects";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useNavigationLayout } from "../layouts";
import { buildEditorPath } from "../lib/editorNavigation";
import { type SessionMessageSender, SessionPageContent } from "./SessionPage";

const MAX_EDITABLE_FILE_SIZE = 1024 * 1024;

interface LoadedFileState {
  path: string;
  content: string;
  size: number;
}

function isPathTooLarge(size: number): boolean {
  return size > MAX_EDITABLE_FILE_SIZE;
}

function ActionButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="inline-flex min-w-[5.5rem] flex-none items-center justify-center rounded-sm border border-[var(--outline-variant)] bg-[var(--surface-container-lowest)] px-3 py-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--on-surface)] transition-colors hover:bg-[var(--surface-container-high)] sm:min-w-[7.5rem]"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function SessionEditorPage() {
  const { showToast } = useToastContext();
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const { projectId, sessionId } = useParams<{
    projectId: string;
    sessionId: string;
  }>();
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
  const [showChatSheet, setShowChatSheet] = useState(false);
  const [fileTreeCollapsed, setFileTreeCollapsed] = useState(false);
  const [draftPersistenceDegraded, setDraftPersistenceDegraded] =
    useState(false);
  const [askAiSending, setAskAiSending] = useState(false);
  const [askAiReady, setAskAiReady] = useState(false);
  const sessionMessageSenderRef = useRef<SessionMessageSender | null>(null);

  const readOnly = useMemo(() => {
    if (!loadedFile) return false;
    return isPathTooLarge(loadedFile.size);
  }, [loadedFile]);

  const buildEditorSessionPath = useCallback(
    (targetProjectId: string, targetSessionId: string) =>
      buildEditorPath({
        basePath,
        projectId: targetProjectId,
        sessionId: targetSessionId,
      }) ?? `${basePath}/projects`,
    [basePath],
  );

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

  const updatePathInUrl = useCallback(
    (path: string) => {
      const next = new URLSearchParams(searchParams);
      next.set("path", path);
      setSearchParams(next, { replace: false });
    },
    [searchParams, setSearchParams],
  );

  const handleFileSelect = useCallback(
    (path: string) => {
      setSelectedFilePath(path);
      updatePathInUrl(path);
      setShowMobileTree(false);
    },
    [updatePathInUrl],
  );

  const handleOpenAiPanel = useCallback(() => {
    if (!selectedFilePath || readOnly || !hasSelection) return;
    setAiPanelOpen(true);
  }, [hasSelection, readOnly, selectedFilePath]);

  const handleAskAi = useCallback(
    async (message: string) => {
      const sender = sessionMessageSenderRef.current;
      if (!sender) {
        showToast("Session chat is still loading.", "error");
        throw new Error("Session chat is still loading.");
      }

      setAskAiSending(true);
      try {
        await sender(message);
        if (!isWideScreen) {
          setShowChatSheet(true);
        }
      } finally {
        setAskAiSending(false);
      }
    },
    [isWideScreen, showToast],
  );

  const handleSessionMessageSenderReady = useCallback(
    (sender: SessionMessageSender | null) => {
      sessionMessageSenderRef.current = sender;
      setAskAiReady(Boolean(sender));
    },
    [],
  );

  const handleBack = useCallback(() => {
    if (projectId && sessionId) {
      navigate(`${basePath}/projects/${projectId}/sessions/${sessionId}`);
      return;
    }
    navigate(`${basePath}/projects`);
  }, [basePath, navigate, projectId, sessionId]);

  const title = project?.name
    ? `${project.name} Editor Mode`
    : projectLoading
      ? "Loading editor mode..."
      : "Session Editor";

  const mobileToolbarActions = !isWideScreen ? (
    <>
      <ActionButton label="Files" onClick={() => setShowMobileTree(true)} />
      <ActionButton label="Chat" onClick={() => setShowChatSheet(true)} />
    </>
  ) : null;

  if (!projectId || !sessionId) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg-surface)] px-4 text-center">
        <div>
          <div className="text-lg font-medium text-[var(--text-primary)]">
            Invalid editor mode URL
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
          ? "flex min-w-0 justify-center overflow-hidden bg-[var(--surface)]"
          : "flex min-h-0 flex-1 flex-col bg-[var(--surface)]"
      }
      style={isWideScreen ? { height: "100dvh" } : undefined}
    >
      <div
        className={
          isWideScreen
            ? "flex h-[100dvh] w-full flex-col"
            : "flex min-h-0 flex-1 flex-col"
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

        <main className="flex min-h-0 flex-1 overflow-hidden bg-[var(--surface)]">
          {isWideScreen &&
            (fileTreeCollapsed ? (
              <div className="flex h-full w-14 shrink-0 items-start justify-center border-r border-[var(--outline-variant)] bg-[var(--surface-container-low)] pt-3 [font-family:var(--font-body)]">
                <button
                  type="button"
                  className="rounded-sm border border-[var(--outline-variant)] bg-[var(--surface-container-lowest)] px-2 py-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--on-surface)] transition-colors hover:bg-[var(--surface-container-high)]"
                  onClick={() => setFileTreeCollapsed(false)}
                >
                  Files
                </button>
              </div>
            ) : (
              <div className="h-full w-[280px] shrink-0 border-r border-[var(--outline-variant)] [font-family:var(--font-body)]">
                <FileTree
                  projectId={projectId}
                  currentFilePath={selectedFilePath}
                  onFileSelect={handleFileSelect}
                  className="border-r-0"
                  headerAction={
                    <button
                      type="button"
                      className="rounded-sm px-2 py-1 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-container-high)] hover:text-[var(--text-primary)]"
                      onClick={() => setFileTreeCollapsed(true)}
                    >
                      Collapse
                    </button>
                  }
                />
              </div>
            ))}

          <div className="flex min-h-0 min-w-0 flex-1 flex-col [font-family:var(--font-body)]">
            <EditorToolbar
              filePath={selectedFilePath}
              dirty={dirty}
              saving={saving}
              readOnly={readOnly}
              draftPersistenceDegraded={draftPersistenceDegraded}
              hasSelection={hasSelection}
              selectedText={selectedText}
              auxiliaryActions={mobileToolbarActions}
              askAiSending={askAiSending}
              askAiReady={askAiReady}
              onSave={() => {
                void handleSave();
              }}
              onOpenAiEdit={handleOpenAiPanel}
              onAskAi={handleAskAi}
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

          {isWideScreen && (
            <aside className="flex h-full w-[32rem] max-w-[45vw] min-w-[24rem] shrink-0 flex-col overflow-hidden border-l border-[var(--outline-variant)] bg-[var(--surface)] [font-family:var(--font-body)]">
              <div className="min-h-0 flex-1 overflow-hidden pt-[10px]">
                <div className="h-full overflow-hidden">
                  <StreamingMarkdownProvider key={sessionId}>
                    <SessionPageContent
                      projectId={projectId}
                      sessionId={sessionId}
                      layout="embedded"
                      sessionPathBuilder={buildEditorSessionPath}
                      onSendMessageReady={handleSessionMessageSenderReady}
                    />
                  </StreamingMarkdownProvider>
                </div>
              </div>
            </aside>
          )}
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

        <MobileFileTreeSheet
          open={!isWideScreen && showChatSheet}
          onClose={() => setShowChatSheet(false)}
          title="Session Chat"
          headerAction={
            <button
              type="button"
              className="rounded-sm px-2 py-1 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-container-high)] hover:text-[var(--text-primary)]"
              onClick={() => setShowChatSheet(false)}
            >
              Close
            </button>
          }
        >
          <StreamingMarkdownProvider key={`${sessionId}-mobile`}>
            <SessionPageContent
              projectId={projectId}
              sessionId={sessionId}
              layout="embedded"
              sessionPathBuilder={buildEditorSessionPath}
              onSendMessageReady={handleSessionMessageSenderReady}
            />
          </StreamingMarkdownProvider>
        </MobileFileTreeSheet>

        {selectedFilePath && (
          <AiEditPanel
            projectId={projectId}
            filePath={selectedFilePath}
            content={editorContent}
            selectedText={selectedText}
            provider={project?.provider}
            open={aiPanelOpen}
            onApply={setEditorContent}
            onClose={() => setAiPanelOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
