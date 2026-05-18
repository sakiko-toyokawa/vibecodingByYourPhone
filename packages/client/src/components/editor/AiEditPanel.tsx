import type { ProviderName } from "@yep-anywhere/shared";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { AiEditResponse } from "../../api/client";
import { api } from "../../api/client";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useResolvedTheme } from "../../hooks/useTheme";
import { ProviderBadge } from "../ProviderBadge";
import { editRenderer } from "../renderers/tools/EditRenderer";
import type {
  EditInput,
  EditResult,
  PatchHunk,
} from "../renderers/tools/types";
import type { RenderContext } from "../renderers/types";

interface AiEditPanelProps {
  projectId: string;
  filePath: string;
  content: string;
  selectedText?: string | null;
  provider?: ProviderName;
  model?: string;
  open: boolean;
  onApply: (content: string) => void;
  onClose: () => void;
}

interface EditPreviewInput extends EditInput {
  _structuredPatch?: PatchHunk[];
  _diffHtml?: string;
}

function SparkIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 1.75l1.3 3.8L13.1 7 9.3 8.45 8 12.25 6.7 8.45 2.9 7l3.8-1.45L8 1.75z" />
      <path d="M12.45 10.45l.5 1.45 1.45.5-1.45.5-.5 1.45-.5-1.45-1.45-.5 1.45-.5.5-1.45z" />
    </svg>
  );
}

function Spinner() {
  return (
    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
  );
}

function getFileName(filePath: string): string {
  const segments = filePath.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? filePath;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "AI edit failed";
}

function toEditPreviewInput(
  filePath: string,
  originalContent: string,
  response: AiEditResponse,
): EditPreviewInput {
  return {
    file_path: filePath,
    old_string: originalContent,
    new_string: response.content,
    replace_all: false,
    _structuredPatch: response.structuredPatch,
    _diffHtml: response.diffHtml,
  };
}

function toEditResult(
  filePath: string,
  originalContent: string,
  response: AiEditResponse,
): EditResult {
  return {
    filePath,
    oldString: originalContent,
    newString: response.content,
    originalFile: originalContent,
    replaceAll: false,
    userModified: false,
    structuredPatch: response.structuredPatch,
  };
}

function SelectionPreview({ selectedText }: { selectedText: string }) {
  return (
    <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
        Selection
      </div>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-[var(--text-secondary)]">
        {selectedText}
      </pre>
    </div>
  );
}

export function AiEditPanel({
  projectId,
  filePath,
  content,
  selectedText,
  provider,
  model,
  open,
  onApply,
  onClose,
}: AiEditPanelProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const requestVersionRef = useRef(0);
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const resolvedTheme = useResolvedTheme();
  const [instruction, setInstruction] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<AiEditResponse | null>(null);

  const activeProvider = response?.provider ?? provider;
  const activeModel = response?.model ?? model;
  const fileName = useMemo(() => getFileName(filePath), [filePath]);
  const resetKey = useMemo(
    () => `${filePath}\u0000${content.length}\u0000${selectedText ?? ""}`,
    [content, filePath, selectedText],
  );

  const renderContext = useMemo<RenderContext>(
    () => ({
      isStreaming: false,
      theme: resolvedTheme === "codex" ? "dark" : "light",
      provider: activeProvider,
    }),
    [activeProvider, resolvedTheme],
  );

  const previewInput = useMemo(
    () =>
      response ? toEditPreviewInput(filePath, content, response) : undefined,
    [content, filePath, response],
  );

  const previewResult = useMemo(
    () => (response ? toEditResult(filePath, content, response) : undefined),
    [content, filePath, response],
  );

  useEffect(() => {
    if (!open) {
      requestVersionRef.current += 1;
      setInstruction("");
      setLoading(false);
      setError(null);
      setResponse(null);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      textareaRef.current?.focus();
    }, 30);

    document.body.style.overflow = "hidden";
    return () => {
      window.clearTimeout(timeoutId);
      document.body.style.overflow = "";
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    void resetKey;
    setError(null);
    setResponse(null);
  }, [open, resetKey]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose, open]);

  async function generateEdit() {
    const trimmedInstruction = instruction.trim();
    if (!trimmedInstruction || loading) return;

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    setLoading(true);
    setError(null);
    setResponse(null);

    try {
      const nextResponse = await api.requestAiEdit(projectId, {
        path: filePath,
        instruction: trimmedInstruction,
        content,
        selectedText: selectedText ?? undefined,
        provider,
        model,
      });

      if (requestVersion !== requestVersionRef.current) return;
      setResponse(nextResponse);
    } catch (requestError) {
      if (requestVersion !== requestVersionRef.current) return;
      setError(toErrorMessage(requestError));
    } finally {
      if (requestVersion === requestVersionRef.current) {
        setLoading(false);
      }
    }
  }

  function handleInstructionKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void generateEdit();
    }
  }

  function handleApply() {
    if (!response) return;
    onApply(response.content);
    onClose();
  }

  function renderDiffPreview(): ReactNode {
    if (!previewInput || !previewResult) return null;

    return editRenderer.renderCollapsedPreview?.(
      previewInput,
      previewResult,
      false,
      renderContext,
    );
  }

  if (!open) {
    return null;
  }

  const panel = (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handled globally
    <div
      className="fixed inset-0 z-[1000] flex bg-black/40"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div
        className={
          isDesktop
            ? "ml-auto flex h-dvh w-full max-w-[30rem] flex-col border-l border-[var(--border-color)] bg-[var(--bg-surface)] shadow-[-8px_0_32px_rgba(0,0,0,0.16)]"
            : "mt-auto flex max-h-[85dvh] w-full flex-col rounded-t-[1.5rem] border border-b-0 border-[var(--border-color)] bg-[var(--bg-surface)] shadow-[0_-8px_32px_rgba(0,0,0,0.16)]"
        }
        role="dialog"
        aria-modal="true"
        aria-label="AI Edit"
      >
        {!isDesktop && (
          <div className="flex justify-center pb-2 pt-3">
            <div className="h-1.5 w-12 rounded-full bg-[var(--border-color)]" />
          </div>
        )}

        <div
          className={`flex items-start justify-between gap-3 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-3 ${isDesktop ? "pt-[max(1rem,env(safe-area-inset-top,0px))]" : ""}`}
        >
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
              AI Edit
            </div>
            <div className="mt-1 truncate text-sm font-medium text-[var(--text-primary)]">
              {fileName}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {activeProvider ? (
                <ProviderBadge provider={activeProvider} model={activeModel} />
              ) : (
                <span className="rounded-md border border-[var(--border-color)] px-2 py-0.5 text-xs text-[var(--text-secondary)]">
                  Current provider
                </span>
              )}
            </div>
          </div>

          <button
            type="button"
            className="rounded-lg px-2 py-1 text-lg leading-none text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            onClick={onClose}
            aria-label="Close AI edit panel"
          >
            x
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom,0px))]">
          {selectedText && selectedText.trim().length > 0 && (
            <SelectionPreview selectedText={selectedText} />
          )}

          <div className="flex flex-col gap-2">
            <label
              htmlFor="ai-edit-instruction"
              className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]"
            >
              Instruction
            </label>
            <textarea
              id="ai-edit-instruction"
              ref={textareaRef}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              onKeyDown={handleInstructionKeyDown}
              rows={5}
              placeholder="Describe the change you want to make"
              className="min-h-28 w-full resize-y rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-3 text-sm leading-6 text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-dimmed)] focus:border-[var(--focus-border)] focus:ring-2 focus:ring-[rgba(153,70,42,0.12)]"
            />
            <div className="text-xs text-[var(--text-muted)]">
              Press `Ctrl+Enter` to generate an edit suggestion.
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                Diff Preview
              </div>
              {loading && (
                <div className="inline-flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                  <Spinner />
                  Generating...
                </div>
              )}
            </div>

            <div className="min-h-[12rem] rounded-xl border border-[var(--border-color)] bg-[var(--bg-surface)] p-3">
              {loading ? (
                <div className="flex h-full min-h-[10rem] flex-col items-center justify-center gap-3 text-sm text-[var(--text-secondary)]">
                  <Spinner />
                  <span>Generating diff preview...</span>
                </div>
              ) : error ? (
                <div className="flex h-full min-h-[10rem] flex-col justify-center gap-3">
                  <div className="rounded-lg border border-[var(--error-color)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--error-color)]">
                    {error}
                  </div>
                  <div className="text-xs text-[var(--text-muted)]">
                    Adjust the instruction and try again.
                  </div>
                </div>
              ) : response ? (
                <div className="min-h-0">{renderDiffPreview()}</div>
              ) : (
                <div className="flex h-full min-h-[10rem] flex-col items-center justify-center gap-3 text-center text-sm text-[var(--text-muted)]">
                  <SparkIcon />
                  <span>Generate a suggestion to preview the patch here.</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-surface)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
              onClick={onClose}
            >
              Cancel
            </button>

            {(error || response) && (
              <button
                type="button"
                className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-surface)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void generateEdit()}
                disabled={loading || instruction.trim().length === 0}
              >
                Retry
              </button>
            )}

            {response && (
              <button
                type="button"
                className="rounded-xl bg-[var(--text-primary)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
                onClick={handleApply}
              >
                Apply changes
              </button>
            )}

            {!response && (
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-xl bg-[var(--text-primary)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void generateEdit()}
                disabled={loading || instruction.trim().length === 0}
              >
                {loading ? <Spinner /> : <SparkIcon />}
                {loading ? "Generating..." : "Generate"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}
