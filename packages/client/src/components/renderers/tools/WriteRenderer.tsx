import { useCallback, useEffect, useMemo, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import { Modal } from "../../ui/Modal";
import type { ToolRenderer, WriteInput, WriteResult } from "./types";

const MAX_LINES_COLLAPSED = 30;
const PREVIEW_LINES = 3;

/** Extended input type with embedded augment data from server */
interface WriteInputWithAugment extends WriteInput {
  _highlightedContentHtml?: string;
  _highlightedLanguage?: string;
  _highlightedTruncated?: boolean;
  _renderedMarkdownHtml?: string;
}

/**
 * Check if file is markdown based on extension.
 */
function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return ext === "md" || ext === "markdown";
}

/**
 * Extract filename from path
 */
function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

/**
 * Truncate highlighted HTML to a specified number of lines.
 * Shiki output wraps each line in <span class="line">.
 */
function truncateHighlightedHtml(html: string, maxLines: number): string {
  const lines = html.split('<span class="line">');
  if (lines.length <= maxLines + 1) return html;

  // Rebuild with only maxLines worth of lines
  const truncated = lines.slice(0, maxLines + 1).join('<span class="line">');
  // Close any open tags
  return `${truncated}</code></pre>`;
}

/**
 * Write tool use - shows file path being written
 */
function WriteToolUse({ input }: { input: WriteInput }) {
  const fileName = getFileName(input.file_path);
  const lineCount = input.content.split("\n").length;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="font-mono [font-size:var(--font-size-base)] text-[var(--link-color)] break-all">
        {fileName}
      </span>
      <span className="text-[var(--text-muted)] [font-size:var(--font-size-base)]">
        {lineCount} lines
      </span>
    </div>
  );
}

/**
 * Modal content for viewing full file contents
 */
function WriteModalContent({
  file,
  input,
}: {
  file: WriteResult["file"];
  input?: WriteInputWithAugment;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const lines = file.content.split("\n");

  const isMarkdown = isMarkdownFile(file.filePath);
  const hasMarkdownPreview = isMarkdown && !!input?._renderedMarkdownHtml;

  // Toggle button for markdown files
  const toggleButton = hasMarkdownPreview && (
    <div className="flex gap-0 p-2 px-3 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
      <button
        type="button"
        className={`px-3 py-1.5 border border-[var(--border-color)] bg-[var(--bg-surface)] text-[var(--text-muted)] [font-size:var(--font-size-sm)] cursor-pointer transition-all duration-150 hover:bg-[var(--bg-hover)] rounded-l ${!showPreview ? "bg-[var(--primary-color)] text-white border-[var(--primary-color)]" : ""}`}
        onClick={() => setShowPreview(false)}
      >
        Source
      </button>
      <button
        type="button"
        className={`px-3 py-1.5 border border-[var(--border-color)] bg-[var(--bg-surface)] text-[var(--text-muted)] [font-size:var(--font-size-sm)] cursor-pointer transition-all duration-150 hover:bg-[var(--bg-hover)] rounded-r border-l-0 ${showPreview ? "bg-[var(--primary-color)] text-white border-[var(--primary-color)]" : ""}`}
        onClick={() => setShowPreview(true)}
      >
        Preview
      </button>
    </div>
  );

  // Show rendered markdown preview
  if (showPreview && input?._renderedMarkdownHtml) {
    return (
      <div className="bg-[var(--bg-code)] rounded overflow-auto">
        {toggleButton}
        <div className="overflow-auto">
          <div
            className="p-4 leading-relaxed text-[var(--text-primary)]"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
            dangerouslySetInnerHTML={{ __html: input._renderedMarkdownHtml }}
          />
        </div>
      </div>
    );
  }

  // Use highlighted HTML if available from input augment
  if (input?._highlightedContentHtml) {
    return (
      <div className="bg-[var(--bg-code)] rounded overflow-auto">
        {toggleButton}
        <div className="font-mono [font-size:var(--font-size-base)] leading-relaxed bg-[var(--bg-code)] overflow-x-auto">
          <div
            className="p-3"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
            dangerouslySetInnerHTML={{ __html: input._highlightedContentHtml }}
          />
          {input._highlightedTruncated && (
            <div className="py-2 px-3 [font-size:var(--font-size-sm)] text-[var(--text-muted)] border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
              Content truncated for highlighting (showing first 2000 lines)
            </div>
          )}
        </div>
      </div>
    );
  }

  // Fallback: plain text with line numbers
  return (
    <div className="bg-[var(--bg-code)] rounded overflow-auto">
      {toggleButton}
      <div className="grid grid-cols-[auto_minmax(0,1fr)] font-mono [font-size:var(--font-size-base)] bg-[var(--bg-code)] tab-[var(--tab-size)] border border-[var(--border-color)] rounded-md">
        <div className="text-right py-3 px-2 text-[var(--text-muted)] select-none border-r border-[var(--border-color)] bg-[var(--bg-secondary)]">
          {lines.map((_, i) => (
            <div key={`ln-${i + 1}`}>{file.startLine + i}</div>
          ))}
        </div>
        <pre className="py-3 px-3 m-0 overflow-x-auto leading-relaxed">
          <code>{file.content}</code>
        </pre>
      </div>
    </div>
  );
}

/**
 * Write tool result - shows written content with line numbers
 * Uses highlighted HTML from input augment when available.
 */
function WriteToolResult({
  result,
  isError,
  input,
}: {
  result: WriteResult;
  isError: boolean;
  input?: WriteInputWithAugment;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("Write", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Write", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Write");

  if (isError || !result?.file) {
    // Extract error message - can be a string or object with content
    let errorMessage = "Failed to write file";
    if (typeof result === "string") {
      errorMessage = result;
    } else if (typeof result === "object" && result !== null) {
      const errorResult = result as { content?: unknown };
      if (errorResult.content) {
        errorMessage = String(errorResult.content);
      }
    }
    return (
      <div className="text-[var(--error-color)] p-2 bg-[var(--bg-error,rgba(207,34,46,0.1))] rounded">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Write" errors={validationErrors} />
        )}
        {errorMessage}
      </div>
    );
  }

  const { file } = result;
  const lines = file.content.split("\n");
  const needsCollapse = lines.length > MAX_LINES_COLLAPSED;
  const fileName = getFileName(file.filePath);

  // Use highlighted HTML if available from input augment
  if (input?._highlightedContentHtml) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-mono [font-size:var(--font-size-base)] text-[var(--link-color)] break-all">
            {fileName}
          </span>
          <span className="text-[var(--text-muted)] [font-size:var(--font-size-sm)]">
            {file.numLines} lines written
          </span>
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Write" errors={validationErrors} />
          )}
        </div>
        <div className="font-mono [font-size:var(--font-size-base)] leading-relaxed bg-[var(--bg-code)] overflow-x-auto">
          <div
            className="p-3"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
            dangerouslySetInnerHTML={{ __html: input._highlightedContentHtml }}
          />
          {input._highlightedTruncated && (
            <div className="py-2 px-3 [font-size:var(--font-size-sm)] text-[var(--text-muted)] border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
              Content truncated for highlighting (showing first 2000 lines)
            </div>
          )}
        </div>
      </div>
    );
  }

  // Fallback: plain text with line numbers and expand/collapse
  const displayLines =
    needsCollapse && !isExpanded ? lines.slice(0, MAX_LINES_COLLAPSED) : lines;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-mono [font-size:var(--font-size-base)] text-[var(--link-color)] break-all">
          {fileName}
        </span>
        <span className="text-[var(--text-muted)] [font-size:var(--font-size-sm)]">
          {file.numLines} lines written
        </span>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Write" errors={validationErrors} />
        )}
      </div>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] font-mono [font-size:var(--font-size-base)] bg-[var(--bg-code)] tab-[var(--tab-size)] border border-[var(--border-color)] rounded-md">
        <div className="text-right py-3 px-2 text-[var(--text-muted)] select-none border-r border-[var(--border-color)] bg-[var(--bg-secondary)]">
          {displayLines.map((_, i) => {
            const lineNum = file.startLine + i;
            return <div key={`line-${lineNum}`}>{lineNum}</div>;
          })}
          {needsCollapse && !isExpanded && <div>...</div>}
        </div>
        <pre className="py-3 px-3 m-0 overflow-x-auto leading-relaxed">
          <code>{displayLines.join("\n")}</code>
        </pre>
      </div>
      {needsCollapse && (
        <button
          type="button"
          className="px-4 py-2 bg-transparent border border-[var(--border-color)] rounded-lg text-[var(--text-muted)] cursor-pointer [font-size:var(--font-size-sm)] mt-2 min-h-[40px] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

/**
 * Collapsed preview showing line count and code preview with fade
 * Clicking opens a modal with the full content
 */
function WriteCollapsedPreview({
  input,
  result,
  isError,
}: {
  input: WriteInputWithAugment;
  result: WriteResult | undefined;
  isError: boolean;
}) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("Write", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Write", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Write");

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!isError) {
        setIsModalOpen(true);
      }
    },
    [isError],
  );

  const handleClose = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  // Use result data if available, otherwise fall back to input
  const content = result?.file?.content ?? input.content;
  const filePath = result?.file?.filePath ?? input.file_path;
  const fileName = getFileName(filePath);
  const lines = content.split("\n");
  const lineCount = result?.file?.numLines ?? lines.length;
  const isTruncated = lines.length > PREVIEW_LINES;

  // Truncate highlighted HTML for preview
  const previewHtml = useMemo(() => {
    if (!input._highlightedContentHtml) return null;
    return truncateHighlightedHtml(
      input._highlightedContentHtml,
      PREVIEW_LINES,
    );
  }, [input._highlightedContentHtml]);

  if (isError) {
    // Extract error message from result - can be a string or object with content
    let errorMessage = "Failed to write file";
    if (typeof result === "string") {
      errorMessage = result;
    } else if (typeof result === "object" && result !== null) {
      const errorResult = result as { content?: unknown };
      if (errorResult.content) {
        errorMessage = String(errorResult.content);
      }
    }
    return (
      <div className="flex flex-col gap-0 [font-size:var(--font-size-base)] bg-[var(--bg-code)] border border-[var(--error-color)] rounded-md overflow-hidden w-full p-2 text-left cursor-default">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Write" errors={validationErrors} />
        )}
        <span className="text-[var(--error-color)] [font-size:var(--font-size-base)]">
          {errorMessage}
        </span>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className="flex flex-col gap-0 [font-size:var(--font-size-base)] bg-[var(--bg-code)] border border-[var(--border-color)] rounded-md overflow-hidden w-full p-0 text-left cursor-pointer transition-colors hover:border-[var(--border-input)] mt-1"
        onClick={handleClick}
      >
        <div className="text-[var(--text-muted)] [font-size:var(--font-size-sm)] py-1 px-2">
          {lineCount} lines
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Write" errors={validationErrors} />
          )}
        </div>
        <div
          className={`relative py-1.5 px-2 ${isTruncated ? "max-h-[4.5rem] overflow-hidden" : ""}`}
        >
          {previewHtml ? (
            <div
              className="p-3"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          ) : (
            <pre className="m-0 font-mono [font-size:var(--font-size-base)] leading-snug whitespace-pre-wrap break-words text-[var(--text-secondary)]">
              <code>{lines.slice(0, PREVIEW_LINES).join("\n")}</code>
            </pre>
          )}
          {isTruncated && (
            <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-b from-transparent to-[var(--bg-code)] pointer-events-none" />
          )}
        </div>
      </button>
      {isModalOpen && (
        <Modal
          title={
            <span className="font-mono [font-size:var(--font-size-base)] text-[var(--link-color)] break-all">
              {fileName}
            </span>
          }
          onClose={handleClose}
        >
          <WriteModalContent
            file={
              result?.file ?? {
                filePath,
                content,
                numLines: lineCount,
                startLine: 1,
                totalLines: lineCount,
              }
            }
            input={input}
          />
        </Modal>
      )}
    </>
  );
}

export const writeRenderer: ToolRenderer<WriteInput, WriteResult> = {
  tool: "Write",

  renderToolUse(input, _context) {
    return <WriteToolUse input={input as WriteInput} />;
  },

  renderToolResult(result, isError, _context, input) {
    return (
      <WriteToolResult
        result={result as WriteResult}
        isError={isError}
        input={input as WriteInputWithAugment | undefined}
      />
    );
  },

  getUseSummary(input) {
    return getFileName((input as WriteInput).file_path);
  },

  getResultSummary(result, isError, input?) {
    if (isError) return "Error";
    const r = result as WriteResult;
    if (r?.file) {
      return getFileName(r.file.filePath);
    }
    // Fall back to input if result not ready
    if (input) {
      return getFileName((input as WriteInput).file_path);
    }
    return "Writing...";
  },

  renderCollapsedPreview(input, result, isError, _context) {
    return (
      <WriteCollapsedPreview
        input={input as WriteInputWithAugment}
        result={result as WriteResult | undefined}
        isError={isError}
      />
    );
  },
};
