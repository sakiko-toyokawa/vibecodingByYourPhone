import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import type { GlobInput, GlobResult, ToolRenderer } from "./types";

const MAX_FILES_COLLAPSED = 20;

/**
 * Extract filename from path
 */
function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

/**
 * Glob tool use - shows pattern being searched
 */
function GlobToolUse({ input }: { input: GlobInput }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="[font-family:var(--font-mono)] text-lg text-[var(--link-color)]">
        {input.pattern}
      </span>
      {input.path && (
        <span className="text-base text-[var(--text-muted)]">
          in {input.path}
        </span>
      )}
    </div>
  );
}

/**
 * Glob tool result - shows list of matching files
 */
function GlobToolResult({
  result,
  isError,
}: {
  result: GlobResult;
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
      const validation = validateToolResult("Glob", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Glob", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Glob");

  if (isError) {
    const errorResult = result as unknown as { content?: unknown } | undefined;
    return (
      <div className="rounded bg-[var(--bg-error,rgba(207,34,46,0.1))] p-2 text-[var(--error-color)]">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Glob" errors={validationErrors} />
        )}
        {typeof result === "object" && errorResult?.content
          ? String(errorResult.content)
          : "Glob search failed"}
      </div>
    );
  }

  if (!result?.filenames || result.filenames.length === 0) {
    return (
      <div className="text-lg italic text-[var(--text-muted)]">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Glob" errors={validationErrors} />
        )}
        No files found
      </div>
    );
  }

  const { filenames, numFiles, truncated } = result;
  const needsCollapse = filenames.length > MAX_FILES_COLLAPSED;
  const displayFiles =
    needsCollapse && !isExpanded
      ? filenames.slice(0, MAX_FILES_COLLAPSED)
      : filenames;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="text-base text-[var(--text-muted)]">
          {numFiles} files
        </span>
        {truncated && (
          <span className="inline-block rounded bg-[var(--bg-warning,rgba(154,103,0,0.15))] px-2 py-0.5 text-sm font-medium text-[var(--warning-color)]">
            truncated
          </span>
        )}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Glob" errors={validationErrors} />
        )}
      </div>
      <div className="flex flex-col gap-1 rounded-md border border-[var(--border-color)] bg-[var(--bg-code)] p-2">
        {displayFiles.map((file) => (
          <div
            key={file}
            className="flex flex-col gap-0.5 rounded p-1 px-2 hover:bg-white/5"
          >
            <span className="font-medium">{getFileName(file)}</span>
            <span className="[font-family:var(--font-mono)] text-sm text-[var(--text-muted)]">
              {file}
            </span>
          </div>
        ))}
        {needsCollapse && !isExpanded && (
          <div className="p-1 px-2 text-base italic text-[var(--text-muted)]">
            ... and {filenames.length - MAX_FILES_COLLAPSED} more
          </div>
        )}
      </div>
      {needsCollapse && (
        <button
          type="button"
          className="cursor-pointer rounded border border-[var(--border-color)] bg-transparent px-4 py-2 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary,var(--text-primary))] active:bg-[var(--bg-tertiary)]"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? "Show less" : `Show all ${filenames.length} files`}
        </button>
      )}
    </div>
  );
}

export const globRenderer: ToolRenderer<GlobInput, GlobResult> = {
  tool: "Glob",

  renderToolUse(input, _context) {
    return <GlobToolUse input={input as GlobInput} />;
  },

  renderToolResult(result, isError, _context) {
    return <GlobToolResult result={result as GlobResult} isError={isError} />;
  },

  getUseSummary(input) {
    return `pattern: "${(input as GlobInput).pattern}"`;
  },

  getResultSummary(result, isError) {
    if (isError) return "Error";
    const r = result as GlobResult;
    if (r?.numFiles === undefined) return "Searching...";
    if (r.numFiles === 0) return "No files found";
    return `Found ${r.numFiles} files`;
  },
};
