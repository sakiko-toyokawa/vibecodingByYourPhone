import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import type { TaskOutputInput, TaskOutputResult, ToolRenderer } from "./types";

const MAX_LINES_COLLAPSED = 20;

const terminalFrameClasses =
  "rounded-lg border border-[var(--border-subtle)] bg-[#171717] px-4 py-3 [font-family:var(--font-mono)] text-[13px] leading-6 text-[#e8e3d8] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]";

const subtleButtonClasses =
  "min-h-[40px] rounded-full border border-black/10 bg-[var(--bg-surface)] px-4 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]";

function StatusBadge({ status }: { status: string }) {
  const tone =
    "border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]";

  const icon =
    status === "completed"
      ? "✓"
      : status === "failed"
        ? "×"
        : status === "timeout"
          ? "!"
          : "●";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${tone}`}
    >
      <span aria-hidden="true">{icon}</span>
      {status}
    </span>
  );
}

function TaskOutputToolUse({ input }: { input: TaskOutputInput }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-muted)]">
      <span className="font-medium text-[var(--text-secondary)]">
        Polling task
      </span>
      <code className="rounded-full border border-black/10 bg-[var(--bg-secondary)] px-2.5 py-1 [font-family:var(--font-mono)] text-[12px] text-[var(--text-secondary)]">
        {input.task_id}
      </code>
      {input.block !== undefined && (
        <span className="rounded-full border border-black/10 bg-[var(--bg-surface)] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
          {input.block ? "blocking" : "non-blocking"}
        </span>
      )}
      {input.timeout !== undefined && (
        <span className="rounded-full border border-black/10 bg-[var(--bg-surface)] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
          timeout: {input.timeout}ms
        </span>
      )}
    </div>
  );
}

function TaskOutputToolResult({
  result,
  isError,
}: {
  result: TaskOutputResult;
  isError: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("TaskOutput", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("TaskOutput", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("TaskOutput");

  if (isError) {
    const errorResult = result as unknown as { content?: unknown } | undefined;
    return (
      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-4 py-3 text-sm text-[var(--text-primary)]">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="TaskOutput" errors={validationErrors} />
        )}
        {typeof result === "object" && errorResult?.content
          ? String(errorResult.content)
          : "Failed to get task output"}
      </div>
    );
  }

  if (!result) {
    return (
      <div className="text-sm italic text-[var(--text-muted)]">No output</div>
    );
  }

  const task = result.task;
  const outputLines = task?.output?.split("\n") || [];
  const needsCollapse = outputLines.length > MAX_LINES_COLLAPSED;
  const displayLines =
    needsCollapse && !isExpanded
      ? outputLines.slice(0, MAX_LINES_COLLAPSED)
      : outputLines;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-muted)]">
        <StatusBadge status={result.retrieval_status} />
        {task?.task_type && (
          <span className="rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
            {task.task_type}
          </span>
        )}
        {task?.description && (
          <span className="text-sm text-[var(--text-secondary)]">
            {task.description}
          </span>
        )}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="TaskOutput" errors={validationErrors} />
        )}
      </div>
      {task && (
        <div className="flex flex-col gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-5 py-4 shadow-[0_1px_0_rgba(20,20,19,0.03)]">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={task.status} />
            {task.exitCode !== null && (
              <span className="rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                exit {task.exitCode}
              </span>
            )}
          </div>
          {task.output && (
            <>
              <pre
                className={`${terminalFrameClasses} overflow-x-auto whitespace-pre-wrap break-words`}
              >
                <code>{displayLines.join("\n")}</code>
              </pre>
              {needsCollapse && (
                <button
                  type="button"
                  className={subtleButtonClasses}
                  onClick={() => setIsExpanded((current) => !current)}
                >
                  {isExpanded
                    ? "Show less"
                    : `Show all ${outputLines.length} lines`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export const taskOutputRenderer: ToolRenderer<
  TaskOutputInput,
  TaskOutputResult
> = {
  tool: "TaskOutput",

  renderToolUse(input, _context) {
    return <TaskOutputToolUse input={input as TaskOutputInput} />;
  },

  renderToolResult(result, isError, _context) {
    return (
      <TaskOutputToolResult
        result={result as TaskOutputResult}
        isError={isError}
      />
    );
  },

  getUseSummary(input) {
    return (input as TaskOutputInput).task_id;
  },

  getResultSummary(result, isError) {
    if (isError) return "Error";
    const r = result as TaskOutputResult;
    if (!r) return "Pending";
    return r.retrieval_status;
  },
};
