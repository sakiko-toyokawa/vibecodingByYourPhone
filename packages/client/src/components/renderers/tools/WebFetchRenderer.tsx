import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import type { ToolRenderer, WebFetchInput, WebFetchResult } from "./types";

const MAX_CONTENT_LINES = 30;

/**
 * Format bytes to human readable
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * WebFetch tool use - shows URL and prompt
 */
function WebFetchToolUse({ input }: { input: WebFetchInput }) {
  return (
    <div className="flex flex-col gap-2">
      <a
        href={input.url}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-[var(--link-color)] no-underline hover:underline"
      >
        {input.url}
      </a>
      {input.prompt && (
        <div className="text-lg text-[var(--text-muted)]">{input.prompt}</div>
      )}
    </div>
  );
}

/**
 * WebFetch tool result - shows fetched content
 */
function WebFetchToolResult({
  result,
  isError,
}: {
  result: WebFetchResult;
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
      const validation = validateToolResult("WebFetch", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("WebFetch", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("WebFetch");

  if (isError) {
    const errorResult = result as unknown as { content?: unknown } | undefined;
    return (
      <div className="rounded bg-[var(--bg-error,rgba(207,34,46,0.1))] p-2 text-[var(--error-color)]">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="WebFetch" errors={validationErrors} />
        )}
        {typeof result === "object" && errorResult?.content
          ? String(errorResult.content)
          : "Fetch failed"}
      </div>
    );
  }

  if (!result) {
    return (
      <div className="text-lg italic text-[var(--text-muted)]">No content</div>
    );
  }

  const lines = result.result?.split("\n") || [];
  const needsCollapse = lines.length > MAX_CONTENT_LINES;
  const displayLines =
    needsCollapse && !isExpanded ? lines.slice(0, MAX_CONTENT_LINES) : lines;

  const statusClass =
    result.code >= 200 && result.code < 300
      ? "bg-[var(--bg-success,rgba(26,127,55,0.15))] text-[var(--success-color)]"
      : result.code >= 400
        ? "bg-[var(--bg-error,rgba(207,34,46,0.15))] text-[var(--error-color)]"
        : "bg-[var(--bg-warning,rgba(154,103,0,0.15))] text-[var(--warning-color)]";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <a
          href={result.url}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-[var(--link-color)] no-underline hover:underline"
        >
          {result.url}
        </a>
        <span
          className={`inline-block rounded px-2 py-0.5 text-sm font-medium ${statusClass}`}
        >
          {result.code} {result.codeText}
        </span>
        <span className="text-sm text-[var(--text-muted)]">
          {formatBytes(result.bytes)} &middot; {result.durationMs}ms
        </span>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="WebFetch" errors={validationErrors} />
        )}
      </div>
      {result.result && (
        <>
          <pre className="m-0 max-h-[400px] overflow-y-auto overflow-x-auto rounded-md border border-[var(--border-color)] bg-[var(--bg-code)] p-3">
            <code>{displayLines.join("\n")}</code>
          </pre>
          {needsCollapse && (
            <button
              type="button"
              className="cursor-pointer rounded border border-[var(--border-color)] bg-transparent px-4 py-2 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary,var(--text-primary))] active:bg-[var(--bg-tertiary)]"
              onClick={() => setIsExpanded(!isExpanded)}
            >
              {isExpanded ? "Show less" : `Show all ${lines.length} lines`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

export const webFetchRenderer: ToolRenderer<WebFetchInput, WebFetchResult> = {
  tool: "WebFetch",

  renderToolUse(input, _context) {
    return <WebFetchToolUse input={input as WebFetchInput} />;
  },

  renderToolResult(result, isError, _context) {
    return (
      <WebFetchToolResult result={result as WebFetchResult} isError={isError} />
    );
  },

  getUseSummary(input) {
    const url = (input as WebFetchInput).url;
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  },

  getResultSummary(result, isError) {
    if (isError) return "Error";
    const r = result as WebFetchResult;
    return r?.code ? `${r.code} ${r.codeText}` : "Fetched";
  },
};
