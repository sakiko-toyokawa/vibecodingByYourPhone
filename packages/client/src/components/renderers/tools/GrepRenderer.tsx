import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import type { GrepInput, GrepResult, ToolRenderer } from "./types";

const MAX_FILES_COLLAPSED = 20;
const MAX_LINES_COLLAPSED = 30;

/**
 * Extract filename from path
 */
function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

/**
 * Grep tool use - shows search pattern
 */
function GrepToolUse({ input }: { input: GrepInput }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="[font-family:var(--font-mono)] text-lg text-[var(--link-color)]">
        {input.pattern}
      </span>
      {input.glob && (
        <span className="text-base text-[var(--text-muted)]">
          ({input.glob})
        </span>
      )}
      {input.path && (
        <span className="text-base text-[var(--text-muted)]">
          in {input.path}
        </span>
      )}
    </div>
  );
}

/**
 * File list view (for files_with_matches mode)
 */
function FileListView({
  filenames,
  isExpanded,
  setIsExpanded,
}: {
  filenames: string[];
  isExpanded: boolean;
  setIsExpanded: (expanded: boolean) => void;
}) {
  const needsCollapse = filenames.length > MAX_FILES_COLLAPSED;
  const displayFiles =
    needsCollapse && !isExpanded
      ? filenames.slice(0, MAX_FILES_COLLAPSED)
      : filenames;

  return (
    <>
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
    </>
  );
}

/**
 * Content view (for content mode)
 */
function ContentView({
  content,
  isExpanded,
  setIsExpanded,
}: {
  content: string;
  isExpanded: boolean;
  setIsExpanded: (expanded: boolean) => void;
}) {
  const lines = content.split("\n");
  const needsCollapse = lines.length > MAX_LINES_COLLAPSED;
  const displayLines =
    needsCollapse && !isExpanded ? lines.slice(0, MAX_LINES_COLLAPSED) : lines;

  return (
    <>
      <pre className="m-0 overflow-x-auto rounded-md border border-[var(--border-color)] bg-[var(--bg-code)] p-3">
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
  );
}

/**
 * Grep tool result - shows search results based on mode
 */
function GrepToolResult({
  result,
  isError,
}: {
  result: GrepResult;
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
      const validation = validateToolResult("Grep", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Grep", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Grep");

  if (isError) {
    const errorResult = result as unknown as { content?: unknown } | undefined;
    return (
      <div className="rounded bg-[var(--bg-error,rgba(207,34,46,0.1))] p-2 text-[var(--error-color)]">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Grep" errors={validationErrors} />
        )}
        {typeof result === "object" && errorResult?.content
          ? String(errorResult.content)
          : "Search failed"}
      </div>
    );
  }

  if (!result) {
    return (
      <div className="text-lg italic text-[var(--text-muted)]">No results</div>
    );
  }

  const { mode, filenames, numFiles, content, appliedLimit } = result;

  // Count mode - just show summary
  if (mode === "count") {
    return (
      <div className="flex flex-col gap-2">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Grep" errors={validationErrors} />
        )}
        <div className="text-lg text-[var(--text-muted)]">
          {numFiles} {numFiles === 1 ? "file" : "files"} matched
        </div>
      </div>
    );
  }

  // Content mode - show search results
  if (mode === "content" && content) {
    // Count actual match lines (lines with :linenum: pattern indicate matches)
    // Handles both single-file format (42:content) and multi-file format (file:42:content)
    const lines = content.split("\n");
    const matchCount = lines.filter((line) => /(^|:)\d+:/.test(line)).length;

    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <span className="text-base text-[var(--text-muted)]">
            {matchCount} {matchCount === 1 ? "match" : "matches"}
          </span>
          {appliedLimit && (
            <span className="inline-block rounded bg-[var(--bg-secondary)] px-2 py-0.5 text-sm font-medium text-[var(--link-color)]">
              limit: {appliedLimit}
            </span>
          )}
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Grep" errors={validationErrors} />
          )}
        </div>
        <ContentView
          content={content}
          isExpanded={isExpanded}
          setIsExpanded={setIsExpanded}
        />
      </div>
    );
  }

  // files_with_matches mode (default) - show file list
  if (!filenames || filenames.length === 0) {
    return (
      <div className="text-lg italic text-[var(--text-muted)]">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Grep" errors={validationErrors} />
        )}
        No matches found
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="text-base text-[var(--text-muted)]">
          {numFiles} files
        </span>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Grep" errors={validationErrors} />
        )}
      </div>
      <FileListView
        filenames={filenames}
        isExpanded={isExpanded}
        setIsExpanded={setIsExpanded}
      />
    </div>
  );
}

export const grepRenderer: ToolRenderer<GrepInput, GrepResult> = {
  tool: "Grep",

  renderToolUse(input, _context) {
    return <GrepToolUse input={input as GrepInput} />;
  },

  renderToolResult(result, isError, _context) {
    return <GrepToolResult result={result as GrepResult} isError={isError} />;
  },

  getUseSummary(input) {
    return (input as GrepInput).pattern;
  },

  getResultSummary(result, isError) {
    if (isError) return "Error";
    const r = result as GrepResult;
    if (!r) return "Results";

    // For content mode, count actual matches
    if (r.mode === "content" && r.content) {
      const matchCount = r.content
        .split("\n")
        .filter((line) => /(^|:)\d+:/.test(line)).length;
      return `${matchCount} ${matchCount === 1 ? "match" : "matches"}`;
    }

    return r.numFiles !== undefined ? `${r.numFiles} files` : "Results";
  },
};
