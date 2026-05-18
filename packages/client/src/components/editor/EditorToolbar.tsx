import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

interface EditorToolbarProps {
  filePath?: string | null;
  dirty: boolean;
  saving?: boolean;
  readOnly?: boolean;
  draftPersistenceDegraded?: boolean;
  hasSelection?: boolean;
  selectedText?: string | null;
  auxiliaryActions?: ReactNode;
  askAiSending?: boolean;
  askAiReady?: boolean;
  onSave: () => void;
  onOpenAiEdit: () => void;
  onAskAi?: ((message: string) => Promise<void>) | null;
}

function SparkIcon() {
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
      <path d="M7 1.5l1.15 3.35L11.5 6 8.15 7.15 7 10.5 5.85 7.15 2.5 6l3.35-1.15L7 1.5z" />
      <path d="M11.25 9.5l.45 1.3 1.3.45-1.3.45-.45 1.3-.45-1.3-1.3-.45 1.3-.45.45-1.3z" />
    </svg>
  );
}

function SaveIcon() {
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
      <path d="M2.5 2.5h7l2 2v7H2.5z" />
      <path d="M4 2.5v3h5v-3" />
      <path d="M4.25 11v-3h5.5v3" />
    </svg>
  );
}

function ChatIcon() {
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
      <path d="M2.25 3.25A1.75 1.75 0 0 1 4 1.5h6a1.75 1.75 0 0 1 1.75 1.75v4.5A1.75 1.75 0 0 1 10 9.5H6.1L3.4 12V9.5H4A1.75 1.75 0 0 1 2.25 7.75z" />
    </svg>
  );
}

function getFileName(filePath?: string | null): string {
  if (!filePath) return "No file selected";
  const parts = filePath.split("/");
  return parts.at(-1) ?? filePath;
}

function buildAskAiMessage(selectedText: string): string {
  return `\`\`\`\n${selectedText}\n\`\`\``;
}

export function EditorToolbar({
  filePath,
  dirty,
  saving = false,
  readOnly = false,
  draftPersistenceDegraded = false,
  hasSelection = false,
  selectedText = null,
  auxiliaryActions,
  askAiSending = false,
  askAiReady = true,
  onSave,
  onOpenAiEdit,
  onAskAi = null,
}: EditorToolbarProps) {
  const askAiInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [askAiOpen, setAskAiOpen] = useState(false);
  const [askAiDraft, setAskAiDraft] = useState("");
  const composerScopeKey = filePath ?? "__no_file__";
  const fileName = getFileName(filePath);
  const canAskAi = Boolean(
    onAskAi &&
      askAiReady &&
      filePath &&
      !readOnly &&
      hasSelection &&
      selectedText?.trim(),
  );

  useEffect(() => {
    if (!askAiOpen) return;
    const timeoutId = window.setTimeout(() => {
      const textarea = askAiInputRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(0, 0);
    }, 20);

    return () => window.clearTimeout(timeoutId);
  }, [askAiOpen]);

  useEffect(() => {
    void composerScopeKey;
    setAskAiOpen(false);
    setAskAiDraft("");
  }, [composerScopeKey]);

  async function handleAskAiSubmit() {
    const trimmed = askAiDraft.trim();
    if (!trimmed || askAiSending || !onAskAi) return;

    try {
      await onAskAi(trimmed);
      setAskAiOpen(false);
      setAskAiDraft("");
    } catch {
      // Keep the draft open so the user can retry or edit it.
    }
  }

  function handleAskAiOpen() {
    if (!selectedText?.trim()) return;
    setAskAiDraft(buildAskAiMessage(selectedText));
    setAskAiOpen(true);
  }

  function handleAskAiKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }

    event.preventDefault();
    void handleAskAiSubmit();
  }

  return (
    <div className="border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-3 [font-family:var(--font-body)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-[var(--text-primary)] [font-family:var(--font-display)]">
              {fileName}
            </span>
            {filePath && (
              <span
                className={`inline-flex h-2.5 w-2.5 rounded-full ${dirty ? "bg-[var(--warning-color)]" : "bg-[var(--success-color)]"}`}
                title={dirty ? "Unsaved changes" : "Saved"}
              />
            )}
            {readOnly && (
              <span className="rounded-md border border-[var(--border-color)] px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
                Read only
              </span>
            )}
            {draftPersistenceDegraded && (
              <span className="rounded-md border border-[var(--warning-color)]/40 bg-[var(--bg-surface)] px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--warning-color)]">
                Drafts not persisted
              </span>
            )}
          </div>
          {filePath && (
            <div className="mt-1 truncate text-xs text-[var(--text-muted)] [font-family:var(--font-body)]">
              {filePath}
            </div>
          )}
        </div>

        <div className="flex w-full flex-wrap items-stretch gap-2 sm:w-auto sm:justify-end">
          {auxiliaryActions}
          {onAskAi && (
            <button
              type="button"
              className="inline-flex min-w-[7.5rem] flex-1 items-center justify-center gap-2 rounded-sm border border-[var(--outline-variant)] bg-[var(--surface-container-lowest)] px-3 py-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--on-surface)] transition-colors hover:bg-[var(--surface-container-high)] disabled:cursor-not-allowed disabled:opacity-50 sm:min-w-0 sm:flex-none"
              onClick={handleAskAiOpen}
              disabled={!canAskAi}
              title={
                !askAiReady
                  ? "Session chat is still loading"
                  : canAskAi
                    ? "Ask AI about selected code"
                    : "Select code to ask AI about it"
              }
            >
              <ChatIcon />
              Ask AI
            </button>
          )}
          <button
            type="button"
            className="inline-flex min-w-[7.5rem] flex-1 items-center justify-center gap-2 rounded-sm border border-[var(--outline-variant)] bg-[var(--surface-container-lowest)] px-3 py-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--on-surface)] transition-colors hover:bg-[var(--surface-container-high)] disabled:cursor-not-allowed disabled:opacity-50 sm:min-w-0 sm:flex-none"
            onClick={onOpenAiEdit}
            disabled={!filePath || readOnly || !hasSelection}
            title={
              hasSelection
                ? "Edit selected code with AI"
                : "Select code to enable AI edit"
            }
          >
            <SparkIcon />
            AI Edit
          </button>
          <button
            type="button"
            className="inline-flex min-w-[7.5rem] flex-1 items-center justify-center gap-2 rounded-sm bg-[var(--primary)] px-3 py-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--on-primary)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 sm:min-w-0 sm:flex-none"
            onClick={onSave}
            disabled={!filePath || readOnly || !dirty || saving}
          >
            <SaveIcon />
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {askAiOpen && onAskAi && (
        <div className="mt-3 rounded-sm border border-[var(--outline-variant)] bg-[var(--surface-container-lowest)] p-3">
          <div className="flex flex-col gap-3 lg:flex-row">
            <textarea
              ref={askAiInputRef}
              value={askAiDraft}
              onChange={(event) => setAskAiDraft(event.target.value)}
              onKeyDown={handleAskAiKeyDown}
              rows={6}
              className="min-h-[8rem] w-full resize-y rounded-sm border border-[var(--outline-variant)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--primary)]"
              placeholder="Ask about the selected code..."
            />

            <div className="flex shrink-0 flex-row gap-2 lg:w-[9rem] lg:flex-col">
              <button
                type="button"
                className="inline-flex min-w-[7rem] flex-1 items-center justify-center rounded-sm bg-[var(--primary)] px-3 py-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--on-primary)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => {
                  void handleAskAiSubmit();
                }}
                disabled={!askAiDraft.trim() || askAiSending}
              >
                {askAiSending ? "Sending..." : "Send"}
              </button>
              <button
                type="button"
                className="inline-flex min-w-[7rem] flex-1 items-center justify-center rounded-sm border border-[var(--outline-variant)] bg-[var(--surface)] px-3 py-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--on-surface)] transition-colors hover:bg-[var(--surface-container-high)]"
                onClick={() => setAskAiOpen(false)}
                disabled={askAiSending}
              >
                Cancel
              </button>
            </div>
          </div>
          <div className="mt-2 text-[11px] text-[var(--text-muted)]">
            Press Enter to send. Use Shift+Enter for a newline.
          </div>
        </div>
      )}
    </div>
  );
}
