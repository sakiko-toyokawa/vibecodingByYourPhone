import { type ReactNode, useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import type { BashOutputInput, BashOutputResult, ToolRenderer } from "./types";

const MAX_LINES_COLLAPSED = 20;

const terminalFrameClasses =
  "rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-code)] px-4 py-3 [font-family:var(--font-mono)] text-[13px] leading-6 text-[var(--text-primary)] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]";

const subtleButtonClasses =
  "min-h-[40px] rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]";

function formatTimestamp(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    return date.toLocaleTimeString();
  } catch {
    return timestamp;
  }
}

function StatusIndicator({ status }: { status: string }) {
  const statusConfig = {
    running: {
      icon: "●",
      className:
        "border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]",
    },
    completed: {
      icon: "✓",
      className:
        "border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]",
    },
    failed: {
      icon: "×",
      className:
        "border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]",
    },
  } as const;

  const config = statusConfig[status as keyof typeof statusConfig] ?? {
    icon: "?",
    className:
      "border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]",
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${config.className}`}
    >
      <span aria-hidden="true">{config.icon}</span>
      {status}
    </span>
  );
}

function CodePanel({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "error";
}) {
  return (
    <pre
      className={`${terminalFrameClasses} overflow-x-auto whitespace-pre-wrap break-words ${tone === "error" ? "border-[var(--error-color)] text-[var(--error-color)]" : ""}`}
    >
      <code>{children}</code>
    </pre>
  );
}

function BashOutputToolUse({ input }: { input: BashOutputInput }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-muted)]">
      <span className="font-medium text-[var(--text-secondary)]">
        Polling background shell
      </span>
      <code className="rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 py-1 [font-family:var(--font-mono)] text-[12px] text-[var(--text-primary)]">
        {input.bash_id}
      </code>
      {input.block !== undefined && (
        <span className="rounded-full border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
          {input.block ? "blocking" : "non-blocking"}
        </span>
      )}
    </div>
  );
}

function BashOutputToolResult({
  result,
  isError,
}: {
  result: BashOutputResult;
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
      const validation = validateToolResult("BashOutput", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("BashOutput", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("BashOutput");

  if (isError) {
    const errorResult = result as unknown as { content?: unknown } | undefined;
    return (
      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-4 py-3 text-sm text-[var(--text-primary)]">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="BashOutput" errors={validationErrors} />
        )}
        {typeof result === "object" && errorResult?.content
          ? String(errorResult.content)
          : "Failed to get bash output"}
      </div>
    );
  }

  if (!result) {
    return (
      <div className="text-sm italic text-[var(--text-muted)]">No output</div>
    );
  }

  const stdoutLines = result.stdout?.split("\n") || [];
  const stderrLines = result.stderr?.split("\n") || [];
  const totalLines = stdoutLines.length + stderrLines.length;
  const needsCollapse = totalLines > MAX_LINES_COLLAPSED;

  const displayStdout =
    needsCollapse && !isExpanded
      ? stdoutLines.slice(0, MAX_LINES_COLLAPSED)
      : stdoutLines;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-muted)]">
        <StatusIndicator status={result.status} />
        {result.command && (
          <code className="[font-family:var(--font-mono)] text-[12px] text-[var(--text-secondary)]">
            {result.command}
          </code>
        )}
        {result.exitCode !== null && (
          <span className="rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
            exit {result.exitCode}
          </span>
        )}
        {result.timestamp && (
          <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--text-dimmed)]">
            {formatTimestamp(result.timestamp)}
          </span>
        )}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="BashOutput" errors={validationErrors} />
        )}
      </div>
      {result.stdout && <CodePanel>{displayStdout.join("\n")}</CodePanel>}
      {result.stderr && <CodePanel tone="error">{result.stderr}</CodePanel>}
      {needsCollapse && (
        <button
          type="button"
          className={subtleButtonClasses}
          onClick={() => setIsExpanded((current) => !current)}
        >
          {isExpanded ? "Show less" : `Show all ${totalLines} lines`}
        </button>
      )}
    </div>
  );
}

export const bashOutputRenderer: ToolRenderer<
  BashOutputInput,
  BashOutputResult
> = {
  tool: "BashOutput",

  renderToolUse(input, _context) {
    return <BashOutputToolUse input={input as BashOutputInput} />;
  },

  renderToolResult(result, isError, _context) {
    return (
      <BashOutputToolResult
        result={result as BashOutputResult}
        isError={isError}
      />
    );
  },

  getUseSummary(input) {
    return (input as BashOutputInput).bash_id;
  },

  getResultSummary(result, isError) {
    if (isError) return "Error";
    const r = result as BashOutputResult;
    if (!r) return "Pending";
    if (r.status === "running") return "Running...";
    if (r.exitCode !== null) return `exit ${r.exitCode}`;
    return r.status;
  },
};
