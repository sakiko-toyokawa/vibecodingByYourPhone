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
      className={`my-2 overflow-hidden rounded-lg border border-[var(--border-color)] border-l-[3px] ${providerStyle.accent} ${providerStyle.bg} ${providerStyle.shadow} transition-all duration-150 ${isNonExpandable ? "" : "hover:border-[var(--border-input)]"}`}
    >
      <div
        className={`flex items-center gap-2 px-4 py-3 text-sm ${isNonExpandable ? "" : "cursor-pointer hover:bg-[var(--bg-hover)]/60"}`}
        onClick={isNonExpandable ? undefined : handleToggle}
        onKeyDown={
          isNonExpandable
            ? undefined
            : (e) => e.key === "Enter" && handleToggle()
        }
        role={isNonExpandable ? "presentation" : "button"}
        tabIndex={isNonExpandable ? undefined : 0}
      >
        {status === "pending" && (
          <span className="shrink-0" aria-label="Running">
            <Spinner />
          </span>
        )}
        {status === "aborted" && (
          <span
            className="shrink-0 text-xs font-bold text-[var(--text-muted)]"
            aria-label="Interrupted"
          >
            !
          </span>
        )}

        <span
          className={`shrink-0 text-[11px] font-medium uppercase tracking-[0.18em] ${providerStyle.label}`}
        >
          {toolRegistry.getDisplayName(toolName)}
        </span>

        {hasInteractiveSummary && status === "complete" ? (
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-muted)]">
            {interactiveSummaryContent}
          </span>
        ) : !hideSummaryWhenPreviewVisible ? (
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-muted)]">
            {summary}
            {status === "aborted" && (
              <span className="ml-1 text-[var(--text-muted)]">
                (interrupted)
              </span>
            )}
          </span>
        ) : null}

        {!isNonExpandable && (
          <span
            className="shrink-0 text-xs text-[var(--text-dimmed)]"
            aria-hidden="true"
          >
            {expanded ? "▾" : "▸"}
          </span>
        )}
      </div>

      {hasCollapsedPreview && (
        <div className="px-4 pb-3">{collapsedPreviewContent}</div>
      )}

      {expanded && !isNonExpandable && (
        <div className="border-t border-[var(--border-color)] px-4 pb-4">
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
