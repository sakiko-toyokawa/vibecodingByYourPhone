import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ZodError } from "zod";
import { AgentContentContext } from "../../../contexts/AgentContentContext";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { useSessionMetadata } from "../../../contexts/SessionMetadataContext";
import { useResolvedTheme } from "../../../hooks/useTheme";
import { classifyToolError } from "../../../lib/classifyToolError";
import { preprocessMessages } from "../../../lib/preprocessMessages";
import { validateToolResult } from "../../../lib/validateToolResult";
import type { Message } from "../../../types";
import { RenderItemComponent } from "../../RenderItemComponent";
import { SchemaWarning } from "../../SchemaWarning";
import { ContentBlockRenderer } from "../ContentBlockRenderer";
import type { TaskInput, TaskResult, ToolRenderer } from "./types";

const MAX_PROMPT_LENGTH = 200;
const MAX_ERROR_SUMMARY_LENGTH = 80;
const taskSectionBadgeClasses =
  "inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em]";
const taskInfoBadgeClasses =
  "inline-flex items-center rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--link-color)]";

function getTaskStatusStyles(status: string) {
  switch (status) {
    case "running":
      return {
        container: "border-[var(--border-subtle)] bg-[var(--bg-secondary)]",
        badge: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
      };
    case "completed":
      return {
        container: "border-[var(--border-subtle)] bg-[var(--bg-secondary)]",
        badge: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
      };
    case "failed":
    case "error":
      return {
        container: "border-[var(--border-subtle)] bg-[var(--bg-secondary)]",
        badge: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
      };
    case "interrupted":
    case "aborted":
    case "timeout":
      return {
        container: "border-[var(--border-subtle)] bg-[var(--bg-secondary)]",
        badge: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
      };
    default:
      return {
        container: "border-[var(--border-color)] bg-[var(--bg-surface)]",
        badge: "bg-[var(--bg-tertiary)] text-[var(--text-muted)]",
      };
  }
}

function extractErrorMessage(
  result: unknown,
): { raw: string; summary: string; label: string } | null {
  if (!result) return null;

  let rawMessage = "";

  if (typeof result === "string") {
    rawMessage = result;
  } else if (typeof result === "object" && result !== null) {
    if ("content" in result) {
      const content = (result as { content: unknown }).content;
      if (typeof content === "string") {
        rawMessage = content;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            block.type === "text" &&
            "text" in block
          ) {
            rawMessage = String(block.text);
            break;
          }
        }
      }
    }
  }

  if (!rawMessage) return null;

  const classified = classifyToolError(rawMessage);
  const summary =
    classified.cleanedMessage.length > MAX_ERROR_SUMMARY_LENGTH
      ? `${classified.cleanedMessage.slice(0, MAX_ERROR_SUMMARY_LENGTH)}...`
      : classified.cleanedMessage;

  return {
    raw: rawMessage,
    summary,
    label: classified.label,
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function TaskToolUse({ input }: { input: TaskInput }) {
  const [showPrompt, setShowPrompt] = useState(false);
  const promptTruncated =
    input.prompt.length > MAX_PROMPT_LENGTH
      ? `${input.prompt.slice(0, MAX_PROMPT_LENGTH)}...`
      : input.prompt;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-[var(--text-primary)]">
          {input.description}
        </span>
        <span className={taskInfoBadgeClasses}>{input.subagent_type}</span>
        {input.model && (
          <span className="inline-flex items-center rounded-full border border-[var(--border-color)] bg-[var(--bg-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-muted)]">
            {input.model}
          </span>
        )}
      </div>
      {input.prompt && (
        <div className="mt-2">
          <button
            type="button"
            className="rounded-lg border border-[var(--border-color)] px-3 py-1.5 text-sm text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            onClick={() => setShowPrompt(!showPrompt)}
          >
            {showPrompt ? "Hide prompt" : "Show prompt"}
          </button>
          {showPrompt && (
            <pre className="mt-2 max-h-52 overflow-y-auto rounded-xl border border-[var(--border-color)] bg-[var(--bg-code)] p-3 text-sm leading-6 text-[var(--text-primary)]">
              <code>{showPrompt ? input.prompt : promptTruncated}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function TaskNestedContent({
  messages,
  isStreaming,
}: {
  messages: Message[];
  isStreaming: boolean;
}) {
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const toggleThinkingExpanded = useCallback(() => {
    setThinkingExpanded((prev) => !prev);
  }, []);

  const renderItems = useMemo(() => preprocessMessages(messages), [messages]);

  return (
    <div className="p-4">
      {renderItems.map((item) => (
        <RenderItemComponent
          key={item.id}
          item={item}
          isStreaming={isStreaming}
          thinkingExpanded={thinkingExpanded}
          toggleThinkingExpanded={toggleThinkingExpanded}
        />
      ))}
    </div>
  );
}

function TaskInline({
  input,
  result,
  isError,
  status,
  toolUseId,
}: {
  input: TaskInput;
  result: TaskResult | undefined;
  isError: boolean;
  status: "pending" | "complete" | "error" | "aborted";
  toolUseId?: string;
}) {
  const resolvedTheme = useResolvedTheme();
  const renderTheme = resolvedTheme === "codex" ? "dark" : "light";
  const { projectId, sessionId } = useSessionMetadata();
  const context = useContext(AgentContentContext);
  const {
    reportValidationError,
    enabled: validationEnabled,
    isToolIgnored,
  } = useSchemaValidationContext();

  const agentId =
    result?.agentId ??
    (toolUseId ? context?.toolUseToAgent.get(toolUseId) : undefined);

  const liveContent = agentId ? context?.agentContent[agentId] : undefined;

  const hasTerminalResult =
    result?.status === "completed" || result?.status === "failed";
  const isRunning =
    !hasTerminalResult &&
    status === "pending" &&
    (liveContent?.status === "running" || !liveContent?.status);

  const [isExpanded, setIsExpanded] = useState(false);
  const [isLoadingContent, setIsLoadingContent] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const isProgrammaticScrollRef = useRef(false);
  const lastHeightRef = useRef(0);

  const scrollToBottom = useCallback((container: HTMLElement) => {
    isProgrammaticScrollRef.current = true;
    container.scrollTop = container.scrollHeight - container.clientHeight;
    lastHeightRef.current = container.scrollHeight;

    requestAnimationFrame(() => {
      isProgrammaticScrollRef.current = false;
    });
  }, []);

  const handleScroll = useCallback(() => {
    if (isProgrammaticScrollRef.current) return;

    const container = contentRef.current;
    if (!container) return;

    const threshold = 100;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom < threshold;
  }, []);

  useEffect(() => {
    const container = contentRef.current;
    if (!container || !isExpanded) return;

    container.addEventListener("scroll", handleScroll);
    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, [handleScroll, isExpanded]);

  useEffect(() => {
    const container = contentRef.current;
    if (!container || !isExpanded || !isRunning) return;

    lastHeightRef.current = container.scrollHeight;

    const resizeObserver = new ResizeObserver(() => {
      const newHeight = container.scrollHeight;
      const heightIncreased = newHeight > lastHeightRef.current;

      if (heightIncreased && shouldAutoScrollRef.current) {
        scrollToBottom(container);
      } else {
        lastHeightRef.current = newHeight;
      }
    });

    for (const child of container.children) {
      resizeObserver.observe(child);
    }

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [isExpanded, isRunning, scrollToBottom]);

  useEffect(() => {
    if (isExpanded && isRunning) {
      shouldAutoScrollRef.current = true;
      const container = contentRef.current;
      if (container) {
        requestAnimationFrame(() => {
          scrollToBottom(container);
        });
      }
    }
  }, [isExpanded, isRunning, scrollToBottom]);

  const loadInitiatedRef = useRef(false);

  useEffect(() => {
    if (!isExpanded || !agentId || !context) return;
    if (loadInitiatedRef.current) return;

    loadInitiatedRef.current = true;

    const loadContent = async () => {
      setIsLoadingContent(true);
      try {
        await context.loadAgentContent(projectId, sessionId, agentId);
      } finally {
        setIsLoadingContent(false);
      }
    };

    loadContent();
  }, [isExpanded, agentId, context, projectId, sessionId]);

  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (!result || !validationEnabled) {
      setValidationErrors(null);
      return;
    }

    const validation = validateToolResult("Task", result);
    if (!validation.valid && validation.errors) {
      setValidationErrors(validation.errors);
      reportValidationError("Task", validation.errors);
    } else {
      setValidationErrors(null);
    }
  }, [result, validationEnabled, reportValidationError]);

  const showValidationWarning =
    validationEnabled && validationErrors !== null && !isToolIgnored("Task");

  const handleExpand = async () => {
    const hasLiveContent =
      liveContent?.messages && liveContent.messages.length > 0;

    if (!isExpanded && agentId && context && !hasLiveContent) {
      setIsExpanded(true);
      setIsLoadingContent(true);
      try {
        await context.loadAgentContent(projectId, sessionId, agentId);
      } finally {
        setIsLoadingContent(false);
      }
    } else {
      setIsExpanded(!isExpanded);
    }
  };

  const errorInfo = isError ? extractErrorMessage(result) : null;

  const getStatusBadge = () => {
    if (isError) {
      const errorLabel = errorInfo?.label ?? "failed";
      return { text: errorLabel };
    }
    if (status === "aborted") return { text: "interrupted" };
    if (isRunning) return { text: "running" };
    if (result?.status === "completed") return { text: "completed" };
    if (result?.status === "failed") return { text: "failed" };
    return { text: "pending" };
  };

  const statusBadge = getStatusBadge();
  const statusStyles = getTaskStatusStyles(statusBadge.text);

  return (
    <div
      className={`my-2 overflow-hidden rounded-lg border shadow-[0_1px_0_rgba(20,20,19,0.03)] ${statusStyles.container}`}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)] focus:outline-none focus-visible:bg-[var(--bg-hover)]"
        onClick={handleExpand}
      >
        <span className="w-4 shrink-0 text-center text-[11px] text-[var(--text-muted)]">
          {isExpanded ? "v" : ">"}
        </span>
        <span className={taskInfoBadgeClasses}>{input.subagent_type}</span>
        <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]">
          {input.description}
        </span>
        {input.model && (
          <span className="hidden shrink-0 rounded-full border border-[var(--border-color)] bg-[var(--bg-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-muted)] md:inline-flex">
            {input.model}
          </span>
        )}
        {isRunning && (
          <>
            <span
              className="inline-flex shrink-0 items-center"
              aria-label="Running"
            >
              <Spinner />
            </span>
            {liveContent?.contextUsage && (
              <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-[var(--text-muted)]">
                {liveContent.contextUsage.percentage.toFixed(0)}% context
              </span>
            )}
          </>
        )}
        {!isRunning && (
          <span
            className={`${taskSectionBadgeClasses} shrink-0 ${statusStyles.badge}`}
          >
            {statusBadge.text}
          </span>
        )}
        {!isExpanded && errorInfo && (
          <span
            className="hidden max-w-[24rem] shrink truncate text-xs text-[var(--text-muted)] lg:inline"
            title={errorInfo.raw}
          >
            {errorInfo.summary}
          </span>
        )}
        {result && !isError && (
          <span className="hidden shrink-0 whitespace-nowrap text-xs text-[var(--text-muted)] md:inline">
            {formatDuration(result.totalDurationMs ?? 0)} ·{" "}
            {(result.totalTokens ?? 0).toLocaleString()} tokens
          </span>
        )}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Task" errors={validationErrors} />
        )}
      </button>

      {isLoadingContent && (
        <div className="flex items-center gap-2 border-t border-[var(--border-color)] px-4 py-3 text-sm text-[var(--text-muted)]">
          <Spinner /> Loading agent content...
        </div>
      )}

      {isExpanded && (
        <div
          className="max-h-[31.25rem] overflow-y-auto border-t border-[var(--border-subtle)] bg-[var(--bg-surface)]"
          ref={contentRef}
        >
          {errorInfo && (
            <div className="p-4">
              <pre className="m-0 whitespace-pre-wrap break-words rounded-xl border-l-4 border-[var(--error-color)] bg-[var(--bg-error)] p-4 text-sm leading-6 text-[var(--text-primary)]">
                {errorInfo.raw}
              </pre>
            </div>
          )}
          {!errorInfo && liveContent?.messages.length ? (
            <TaskNestedContent
              messages={liveContent.messages}
              isStreaming={isRunning}
            />
          ) : !errorInfo && result?.content?.length ? (
            <div className="border-l-2 border-[var(--border-color)] px-4 py-4">
              {result.content.map((block) => (
                <ContentBlockRenderer
                  key={
                    block.id ??
                    `${agentId}-${block.type}-${block.text?.slice(0, 20) ?? ""}`
                  }
                  block={block}
                  context={{ isStreaming: false, theme: renderTheme }}
                />
              ))}
            </div>
          ) : !errorInfo ? (
            <div className="px-4 py-4 text-base italic text-[var(--text-muted)]">
              {isRunning ? "Waiting for agent activity..." : "No content"}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="h-3 w-3 animate-spin text-[var(--link-color)]"
      viewBox="0 0 16 16"
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

function TaskToolResult({
  result,
  isError,
}: {
  result: TaskResult;
  isError: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(true);

  if (isError) {
    return (
      <div className="rounded-xl border border-[var(--error-color)]/20 bg-[var(--bg-error)] px-4 py-3 text-[var(--error-color)]">
        {typeof result === "object" && "content" in result
          ? String(result.content)
          : "Task failed"}
      </div>
    );
  }

  if (!result) {
    return (
      <div className="text-base italic text-[var(--text-muted)]">No result</div>
    );
  }

  const statusClass =
    result.status === "completed"
      ? "bg-[var(--bg-success)] text-[var(--success-color)]"
      : result.status === "failed"
        ? "bg-[var(--bg-error)] text-[var(--error-color)]"
        : "bg-[var(--bg-warning)] text-[var(--warning-color)]";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`${taskSectionBadgeClasses} ${statusClass}`}>
          {result.status}
        </span>
        <span className="text-sm text-[var(--text-muted)]">
          {formatDuration(result.totalDurationMs ?? 0)} &middot;{" "}
          {(result.totalTokens ?? 0).toLocaleString()} tokens &middot;{" "}
          {result.totalToolUseCount ?? 0} tools
        </span>
        <button
          type="button"
          className="cursor-pointer rounded border border-[var(--border-color)] bg-transparent px-4 py-2 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary,var(--text-primary))] active:bg-[var(--bg-tertiary)]"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? "Collapse" : "Expand"}
        </button>
      </div>
      {isExpanded && result.content && result.content.length > 0 && (
        <div className="border-l-2 border-[var(--border-color)] pl-4">
          {result.content.map((block, i) => (
            <ContentBlockRenderer
              key={`${result.agentId}-${i}`}
              block={block}
              context={{ isStreaming: false, theme: renderTheme }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export const taskRenderer: ToolRenderer<TaskInput, TaskResult> = {
  tool: "Task",

  renderToolUse(input, _context) {
    return <TaskToolUse input={input as TaskInput} />;
  },

  renderToolResult(result, isError, _context) {
    return <TaskToolResult result={result as TaskResult} isError={isError} />;
  },

  getUseSummary(input) {
    return (input as TaskInput).description;
  },

  getResultSummary(result, isError) {
    if (isError) return "Error";
    const r = result as TaskResult;
    return r?.status
      ? `${r.status} (${r.totalToolUseCount} tools)`
      : "Complete";
  },

  renderInline(input, result, isError, status, context) {
    return (
      <TaskInline
        input={input as TaskInput}
        result={result as TaskResult | undefined}
        isError={isError}
        status={status}
        toolUseId={context.toolUseId}
      />
    );
  },
};
