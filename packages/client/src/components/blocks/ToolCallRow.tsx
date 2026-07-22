import { memo, useMemo, useState } from "react";
import { useResolvedTheme } from "../../hooks/useTheme";
import {
  getDisplayBashCommandFromInput,
  isCodexLikeBashInput,
} from "../../lib/bashCommand";
import { getProviderStyle } from "../../lib/providerStyle";
import type { ToolResultData } from "../../types/renderItems";
import { toolRegistry } from "../renderers/tools";
import type { RenderContext } from "../renderers/types";
import { getToolSummary } from "../tools/summaries";

interface Props {
  id: string;
  toolName: string;
  toolInput: unknown;
  toolResult?: ToolResultData;
  status: "pending" | "complete" | "error" | "aborted";
  sessionProvider?: string;
}

export const ToolCallRow = memo(function ToolCallRow({
  id,
  toolName,
  toolInput,
  toolResult,
  status,
  sessionProvider,
}: Props) {
  const resolvedTheme = useResolvedTheme();
  const renderTheme = resolvedTheme === "codex" ? "dark" : "light";
  const renderContext: RenderContext = useMemo(
    () => ({
      isStreaming: status === "pending",
      theme: renderTheme,
      toolUseId: id,
      provider: sessionProvider,
    }),
    [status, renderTheme, id, sessionProvider],
  );

  const structuredResult = toolResult?.structured ?? toolResult?.content;
  const hasInlineRenderer = toolRegistry.hasInlineRenderer(toolName);
  const suppressCollapsedPreview = shouldSuppressBashCollapsedPreview(
    toolName,
    toolInput,
    sessionProvider,
    status,
  );

  const interactiveSummaryContent = useMemo(() => {
    if (status !== "complete") {
      return null;
    }
    return toolRegistry.renderInteractiveSummary(
      toolName,
      toolInput,
      structuredResult,
      toolResult?.isError ?? false,
      renderContext,
    );
  }, [
    status,
    toolName,
    toolInput,
    structuredResult,
    toolResult,
    renderContext,
  ]);

  const hasInteractiveSummary =
    interactiveSummaryContent !== null &&
    interactiveSummaryContent !== undefined &&
    interactiveSummaryContent !== false;

  const collapsedPreviewContent = useMemo(() => {
    if (suppressCollapsedPreview) {
      return null;
    }
    return toolRegistry.renderCollapsedPreview(
      toolName,
      toolInput,
      structuredResult,
      toolResult?.isError ?? false,
      renderContext,
    );
  }, [
    suppressCollapsedPreview,
    toolName,
    toolInput,
    structuredResult,
    toolResult,
    renderContext,
  ]);

  const hasCollapsedPreview =
    collapsedPreviewContent !== null &&
    collapsedPreviewContent !== undefined &&
    collapsedPreviewContent !== false;
  const hideSummaryWhenPreviewVisible =
    toolName === "Bash" &&
    status === "pending" &&
    hasCollapsedPreview &&
    isCodexLikeBashInput(toolInput, sessionProvider);
  const isNonExpandable = hasInteractiveSummary || hasCollapsedPreview;

  const [expanded, setExpanded] = useState(
    !isNonExpandable && (toolName === "Edit" || toolName === "TodoWrite"),
  );

  const summary = useMemo(() => {
    return getToolSummary(toolName, toolInput, toolResult, status);
  }, [toolName, toolInput, toolResult, status]);

  const handleToggle = () => {
    if (!isNonExpandable) {
      setExpanded(!expanded);
    }
  };

  const providerStyle = getProviderStyle(sessionProvider);
  const summaryContent =
    hasInteractiveSummary && status === "complete"
      ? interactiveSummaryContent
      : !hideSummaryWhenPreviewVisible
        ? summary
        : null;

  if (hasInlineRenderer) {
    return (
      <div className="my-2 overflow-hidden rounded-lg">
        {toolRegistry.renderInline(
          toolName,
          toolInput,
          structuredResult,
          toolResult?.isError ?? false,
          status,
          renderContext,
        )}
      </div>
    );
  }

  return (
    <div
      className={`my-2 overflow-hidden rounded-lg border border-[var(--border-color)] ${providerStyle.bg} ${providerStyle.shadow} transition-all duration-150 ${isNonExpandable ? "" : "hover:border-[var(--border-input)]"}`}
    >
      <div
        className={`px-3 py-2.5 sm:px-4 sm:py-3 ${isNonExpandable ? "" : "cursor-pointer hover:bg-[var(--bg-hover)]/60"}`}
        onClick={isNonExpandable ? undefined : handleToggle}
        onKeyDown={
          isNonExpandable
            ? undefined
            : (e) => e.key === "Enter" && handleToggle()
        }
        role={isNonExpandable ? "presentation" : "button"}
        tabIndex={isNonExpandable ? undefined : 0}
      >
        <div className="flex items-start gap-3">
          {status === "pending" && (
            <span className="mt-0.5 shrink-0" aria-label="Running">
              <Spinner />
            </span>
          )}
          {status === "aborted" && (
            <span
              className="mt-0.5 shrink-0 text-xs font-bold text-[var(--text-muted)]"
              aria-label="Interrupted"
            >
              !
            </span>
          )}

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] sm:text-[11px] ${providerStyle.badge}`}
              >
                {toolRegistry.getDisplayName(toolName)}
              </span>

              {summaryContent && (
                <span className="hidden min-w-0 flex-1 truncate text-xs text-[var(--text-muted)] sm:block">
                  {summaryContent}
                  {status === "aborted" && (
                    <span className="ml-1 text-[var(--text-muted)]">
                      (interrupted)
                    </span>
                  )}
                </span>
              )}
            </div>

            {summaryContent && (
              <div className="mt-2 text-xs leading-5 text-[var(--text-muted)] sm:hidden">
                {summaryContent}
                {status === "aborted" && (
                  <span className="ml-1 text-[var(--text-muted)]">
                    (interrupted)
                  </span>
                )}
              </div>
            )}
          </div>

          {!isNonExpandable && (
            <span
              className="mt-0.5 shrink-0 text-[var(--text-dimmed)]"
              aria-hidden="true"
            >
              <svg
                className={`h-4 w-4 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
                viewBox="0 0 16 16"
                fill="none"
              >
                <path
                  d="M6 3l5 5-5 5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          )}
        </div>
      </div>

      {hasCollapsedPreview && (
        <div className="px-3 pb-3 sm:px-4">{collapsedPreviewContent}</div>
      )}

      {expanded && !isNonExpandable && (
        <div className="border-t border-[var(--border-color)] px-3 pb-4 sm:px-4">
          {status === "pending" || status === "aborted" ? (
            <ToolUseExpanded
              toolName={toolName}
              toolInput={toolInput}
              context={renderContext}
            />
          ) : (
            <ToolResultExpanded
              toolName={toolName}
              toolInput={toolInput}
              toolResult={toolResult}
              context={renderContext}
            />
          )}
        </div>
      )}
    </div>
  );
});

function shouldSuppressBashCollapsedPreview(
  toolName: string,
  toolInput: unknown,
  sessionProvider?: string,
  status?: "pending" | "complete" | "error" | "aborted",
): boolean {
  if (toolName !== "Bash") {
    return false;
  }

  if (!isCodexLikeBashInput(toolInput, sessionProvider)) {
    return false;
  }

  if (
    status === "pending" ||
    status === "complete" ||
    status === "error" ||
    status === "aborted"
  ) {
    return true;
  }

  const command = getDisplayBashCommandFromInput(toolInput);
  if (!command) {
    return false;
  }

  return /^(rg|grep|sed|nl|cat)\b/.test(command.trimStart());
}

function ToolUseExpanded({
  toolName,
  toolInput,
  context,
}: {
  toolName: string;
  toolInput: unknown;
  context: RenderContext;
}) {
  return (
    <div className="pt-3">
      {toolRegistry.renderToolUse(toolName, toolInput, context)}
    </div>
  );
}

function ToolResultExpanded({
  toolName,
  toolInput,
  toolResult,
  context,
}: {
  toolName: string;
  toolInput: unknown;
  toolResult: ToolResultData | undefined;
  context: RenderContext;
}) {
  if (!toolResult) {
    return (
      <div className="pt-3 text-sm italic text-[var(--text-dimmed)]">
        No result data
      </div>
    );
  }

  const result = toolResult.structured ?? toolResult.content;

  return (
    <div className="pt-3">
      {toolRegistry.renderToolResult(
        toolName,
        result,
        toolResult.isError,
        context,
        toolInput,
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin text-[var(--primary-color)]"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="24"
        strokeDashoffset="8"
      />
    </svg>
  );
}
