import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToolApprovalFeedbackDraft } from "../hooks/useDrafts";
import { useResolvedTheme } from "../hooks/useTheme";
import { useI18n } from "../i18n";
import type { InputRequest } from "../types";
import { toolRegistry } from "./renderers/tools";
import type { RenderContext } from "./renderers/types";
import { getToolSummary } from "./tools/summaries";
import { Modal } from "./ui/Modal";

// Tools that can be auto-approved with "accept edits" mode
const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];

// Check if this is an ExitPlanMode approval (needs custom UI)
const isExitPlanMode = (toolName: string | undefined) =>
  toolName === "ExitPlanMode";

interface Props {
  request: InputRequest;
  sessionId: string;
  onApprove: () => Promise<void>;
  onDeny: () => Promise<void>;
  onApproveAcceptEdits?: () => Promise<void>;
  onDenyWithFeedback?: (feedback: string) => Promise<void>;
  /** Whether the panel is collapsed (controlled externally) */
  collapsed?: boolean;
  /** Callback when collapse state changes */
  onCollapsedChange?: (collapsed: boolean) => void;
}

// Delay before buttons become clickable to prevent accidental clicks
const CLICK_PROTECTION_MS = 150;

export function ToolApprovalPanel({
  request,
  sessionId,
  onApprove,
  onDeny,
  onApproveAcceptEdits,
  onDenyWithFeedback,
  collapsed = false,
  onCollapsedChange,
}: Props) {
  const { t } = useI18n();
  const resolvedTheme = useResolvedTheme();
  const renderTheme = resolvedTheme === "codex" ? "dark" : "light";
  const [submitting, setSubmitting] = useState(false);
  // Prevent accidental clicks by disabling buttons briefly when panel appears
  const [armed, setArmed] = useState(false);
  // Show feedback panel if there's already draft text from localStorage
  const [feedback, setFeedback, clearFeedback] =
    useToolApprovalFeedbackDraft(sessionId);
  const [showFeedback, setShowFeedback] = useState(() => feedback.length > 0);
  const feedbackInputRef = useRef<HTMLInputElement>(null);

  // Reset armed state when request changes (new approval appears)
  // biome-ignore lint/correctness/useExhaustiveDependencies: request.id triggers reset on new request
  useEffect(() => {
    setArmed(false);
    const timer = setTimeout(() => setArmed(true), CLICK_PROTECTION_MS);
    return () => clearTimeout(timer);
  }, [request.id]);

  const isEditTool = request.toolName && EDIT_TOOLS.includes(request.toolName);

  const handleApprove = useCallback(async () => {
    setSubmitting(true);
    try {
      await onApprove();
    } finally {
      setSubmitting(false);
    }
  }, [onApprove]);

  const handleApproveAcceptEdits = useCallback(async () => {
    if (!onApproveAcceptEdits) return;
    setSubmitting(true);
    try {
      await onApproveAcceptEdits();
    } finally {
      setSubmitting(false);
    }
  }, [onApproveAcceptEdits]);

  const handleDeny = useCallback(async () => {
    setSubmitting(true);
    try {
      await onDeny();
    } finally {
      setSubmitting(false);
    }
  }, [onDeny]);

  const handleDenyWithFeedback = useCallback(async () => {
    if (!onDenyWithFeedback || !feedback.trim()) return;
    setSubmitting(true);
    try {
      await onDenyWithFeedback(feedback.trim());
      // Clear feedback draft from localStorage on successful submit
      clearFeedback();
      setShowFeedback(false);
    } finally {
      setSubmitting(false);
    }
  }, [onDenyWithFeedback, feedback, clearFeedback]);

  // Focus feedback input when shown
  useEffect(() => {
    if (showFeedback && feedbackInputRef.current) {
      feedbackInputRef.current.focus();
    }
  }, [showFeedback]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (submitting || !armed) return;

      // Don't handle shortcuts when typing in feedback
      if (showFeedback) {
        if (e.key === "Escape") {
          e.preventDefault();
          setShowFeedback(false);
          clearFeedback();
        } else if (e.key === "Enter" && feedback.trim()) {
          e.preventDefault();
          handleDenyWithFeedback();
        }
        return;
      }

      const isPlanMode = isExitPlanMode(request.toolName);

      if (isPlanMode) {
        // ExitPlanMode: 1=auto-accept, 2=manual, 3=deny
        if (e.key === "1" && onApproveAcceptEdits) {
          e.preventDefault();
          handleApproveAcceptEdits();
        } else if (e.key === "2") {
          e.preventDefault();
          handleApprove();
        } else if (e.key === "3") {
          e.preventDefault();
          handleDeny();
        } else if (e.key === "Enter" && !e.shiftKey && onApproveAcceptEdits) {
          e.preventDefault();
          handleApproveAcceptEdits();
        } else if (e.key === "Escape") {
          e.preventDefault();
          handleDeny();
        }
      } else {
        // Standard tool approval: 1=yes, 2=yes+auto (edit tools), 2/3=no
        if (e.key === "1") {
          e.preventDefault();
          handleApprove();
        } else if (e.key === "2" && isEditTool && onApproveAcceptEdits) {
          e.preventDefault();
          handleApproveAcceptEdits();
        } else if (
          e.key === "3" ||
          (e.key === "2" && (!isEditTool || !onApproveAcceptEdits))
        ) {
          e.preventDefault();
          handleDeny();
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleApprove();
        } else if (e.key === "Escape") {
          e.preventDefault();
          handleDeny();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    handleApprove,
    handleApproveAcceptEdits,
    handleDeny,
    handleDenyWithFeedback,
    submitting,
    armed,
    showFeedback,
    feedback,
    clearFeedback,
    isEditTool,
    onApproveAcceptEdits,
    request.toolName,
  ]);

  const summary = request.toolName
    ? getToolSummary(request.toolName, request.toolInput, undefined, "pending")
    : request.prompt;

  const [showPreviewModal, setShowPreviewModal] = useState(false);

  // Only show "View details" when the approval summary text itself is too
  // long to display inline. The full tool details (diffs, etc.) are already
  // visible in the session stream above.
  const summaryText = `Allow ${request.toolName ?? ""} ${summary ?? ""}?`;
  const showViewDetails = summaryText.length > 120;

  const renderContext: RenderContext = useMemo(
    () => ({
      isStreaming: true,
      theme: renderTheme,
      toolUseId: request.id,
    }),
    [request.id, renderTheme],
  );

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[0_1px_0_rgba(20,20,19,0.03)]">
      {/* Floating toggle button */}
      <button
        type="button"
        className={`flex w-full items-center justify-center border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] py-1.5 text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] ${collapsed ? "border-[var(--warning-color)]/30 bg-[var(--bg-warning)] text-[var(--warning-color)]" : ""}`}
        onClick={() => onCollapsedChange?.(!collapsed)}
        aria-label={
          collapsed ? t("toolApprovalExpand") : t("toolApprovalCollapse")
        }
        aria-expanded={!collapsed}
      >
        <span
          className={`transition-transform duration-150 ${collapsed ? "" : "rotate-180"}`}
        >
          &#x25bc;
        </span>
      </button>

      {!collapsed && (
        <div className="p-3">
          <div className="flex flex-col gap-1 mb-3">
            {isExitPlanMode(request.toolName) ? (
              <>
                <span className="text-sm font-semibold text-[var(--text-primary)]">
                  {t("toolApprovalPlanTitle")}
                </span>
                <span className="text-xs text-[var(--text-muted)]">
                  {t("toolApprovalPlanSubtitle")}
                </span>
              </>
            ) : (
              <>
                <div className="flex items-start gap-2 flex-wrap">
                  <span className="min-w-0 flex-1 text-sm text-[var(--text-secondary)]">
                    {t("toolApprovalAllow", {
                      tool: request.toolName ?? "",
                      summary: summary ?? "",
                    })}
                  </span>
                  {showViewDetails && (
                    <button
                      type="button"
                      className="shrink-0 cursor-pointer border-none bg-transparent p-0 text-xs text-[var(--link-color)] underline hover:text-[var(--accent-primary)]"
                      onClick={() => setShowPreviewModal(true)}
                    >
                      {t("toolApprovalViewDetails")}
                    </button>
                  )}
                </div>
                {showPreviewModal && request.toolName && (
                  <Modal
                    title={t("toolApprovalDetailsTitle", {
                      tool: request.toolName,
                    })}
                    onClose={() => setShowPreviewModal(false)}
                  >
                    <div className="pt-2">
                      {toolRegistry.renderToolUse(
                        request.toolName,
                        request.toolInput,
                        renderContext,
                      )}
                    </div>
                  </Modal>
                )}
              </>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            {isExitPlanMode(request.toolName) ? (
              <>
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-md bg-[var(--primary)] px-3 py-2 text-sm font-medium text-[var(--on-primary)] transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={handleApproveAcceptEdits}
                  disabled={!armed || submitting || !onApproveAcceptEdits}
                >
                  <kbd className="rounded bg-current/15 px-1.5 py-0.5 text-xs font-mono">
                    1
                  </kbd>
                  <span>{t("toolApprovalYesAuto")}</span>
                </button>
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={handleApprove}
                  disabled={!armed || submitting}
                >
                  <kbd className="rounded bg-[var(--bg-hover)] px-1.5 py-0.5 text-xs font-mono text-[var(--text-muted)]">
                    2
                  </kbd>
                  <span>{t("toolApprovalYesManual")}</span>
                </button>
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={handleDeny}
                  disabled={!armed || submitting}
                >
                  <kbd className="rounded bg-[var(--bg-hover)] px-1.5 py-0.5 text-xs font-mono text-[var(--text-muted)]">
                    3
                  </kbd>
                  <span>{t("toolApprovalNoKeepPlanning")}</span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-md bg-[var(--primary)] px-3 py-2 text-sm font-medium text-[var(--on-primary)] transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={handleApprove}
                  disabled={!armed || submitting}
                >
                  <kbd className="rounded bg-current/15 px-1.5 py-0.5 text-xs font-mono">
                    1
                  </kbd>
                  <span>{t("toolApprovalYes")}</span>
                </button>

                {isEditTool && onApproveAcceptEdits && (
                  <button
                    type="button"
                    className="flex items-center gap-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={handleApproveAcceptEdits}
                    disabled={!armed || submitting}
                  >
                    <kbd className="rounded bg-[var(--bg-hover)] px-1.5 py-0.5 text-xs font-mono text-[var(--text-muted)]">
                      2
                    </kbd>
                    <span>{t("toolApprovalYesDontAsk")}</span>
                  </button>
                )}

                <button
                  type="button"
                  className="flex items-center gap-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={handleDeny}
                  disabled={!armed || submitting}
                >
                  <kbd className="rounded bg-[var(--bg-hover)] px-1.5 py-0.5 text-xs font-mono text-[var(--text-muted)]">
                    {isEditTool && onApproveAcceptEdits ? "3" : "2"}
                  </kbd>
                  <span>{t("toolApprovalNo")}</span>
                </button>
              </>
            )}

            {onDenyWithFeedback && !showFeedback && (
              <button
                type="button"
                className="rounded-md bg-transparent px-3 py-2 text-left text-sm text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => setShowFeedback(true)}
                disabled={!armed || submitting}
              >
                <span>{t("toolApprovalTellInstead")}</span>
              </button>
            )}

            {onDenyWithFeedback && showFeedback && (
              <div className="flex gap-2 mt-1">
                <input
                  ref={feedbackInputRef}
                  type="text"
                  placeholder={t("toolApprovalFeedbackPlaceholder")}
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  disabled={!armed || submitting}
                  className="flex-1 rounded-md border border-[var(--border-input)] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--focus-border)]"
                />
                <button
                  type="button"
                  className="shrink-0 rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--on-primary)] transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={handleDenyWithFeedback}
                  disabled={!armed || submitting || !feedback.trim()}
                >
                  {t("toolApprovalSend")}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
