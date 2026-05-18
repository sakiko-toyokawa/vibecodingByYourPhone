import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { useSessionMetadata } from "../../../contexts/SessionMetadataContext";
import { useExpandedDiff } from "../../../hooks/useExpandedDiff";
import { useRemoteBasePath } from "../../../hooks/useRemoteBasePath";
import { useResolvedTheme } from "../../../hooks/useTheme";
import {
  classifyToolError,
  getErrorClassSuffix,
  isUserRejection,
} from "../../../lib/classifyToolError";
import { buildEditorPath } from "../../../lib/editorNavigation";
import { getProviderStyle } from "../../../lib/providerStyle";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import { Modal } from "../../ui/Modal";
import type { EditInput, EditResult, PatchHunk, ToolRenderer } from "./types";

const MAX_VISIBLE_LINES = 12;

/** Extended input type with embedded augment data from server */
interface EditInputWithAugment extends EditInput {
  _structuredPatch?: PatchHunk[];
  _diffHtml?: string;
  _rawPatch?: string;
}

function extractFilePathFromRawPatch(rawPatch?: string): string | undefined {
  if (typeof rawPatch !== "string" || rawPatch.trim().length === 0) {
    return undefined;
  }

  const lines = rawPatch.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    const match = line.match(
      /^\*\*\*\s+(?:Update File|Add File|Delete File|Move to):\s+(.+?)\s*$/,
    );
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return undefined;
}

function getEditFilePath(
  input?: EditInputWithAugment,
  result?: Partial<EditResult>,
): string {
  return (
    result?.filePath ??
    input?.file_path ??
    extractFilePathFromRawPatch(input?._rawPatch) ??
    ""
  );
}

/**
 * Extract filename from path.
 * Some Codex tool aliases (e.g. apply_patch -> Edit) may not include file_path.
 */
function getFileName(filePath?: string): string {
  if (typeof filePath !== "string") return "Patch";
  const trimmed = filePath.trim();
  if (!trimmed) return "Patch";
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] || trimmed;
}

/**
 * Check if this is a Claude plan file
 */
function isPlanFile(filePath: string): boolean {
  return filePath.includes(".claude/plans/");
}

/**
 * Compute change summary from structuredPatch
 */
function computeChangeSummary(structuredPatch: PatchHunk[]): string | null {
  if (!structuredPatch || structuredPatch.length === 0) return null;

  const additions = structuredPatch
    .flatMap((h) => h.lines)
    .filter((l) => l.startsWith("+")).length;
  const deletions = structuredPatch
    .flatMap((h) => h.lines)
    .filter((l) => l.startsWith("-")).length;

  if (additions > 0 && deletions > 0) {
    return `Modified ${additions + deletions} lines`;
  }
  if (additions > 0) {
    return `Added ${additions} line${additions !== 1 ? "s" : ""}`;
  }
  if (deletions > 0) {
    return `Removed ${deletions} line${deletions !== 1 ? "s" : ""}`;
  }
  return null;
}

function truncateByLines(
  text: string,
  maxLines: number,
): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return { text, truncated: false };
  }
  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true,
  };
}

/**
 * Render diff lines (shared between pending preview and result fallback)
 * Memoized to prevent scroll reset when parent re-renders.
 */
const DiffLines = memo(function DiffLines({
  lines,
}: {
  lines: string[];
}) {
  const theme = useResolvedTheme();
  const style = getProviderStyle(theme);
  return (
    <div className="my-2 first:mt-0 rounded overflow-hidden border border-[var(--border-color)]">
      <pre className="m-0 p-0 bg-[var(--bg-code)] overflow-x-auto tab-[var(--tab-size)]">
        {lines.map((line, i) => {
          const prefix = line[0];
          const lineClass =
            prefix === "-"
              ? `${style.diffRemoved}`
              : prefix === "+"
                ? `${style.diffAdded}`
                : "text-[var(--text-muted)]";
          const key = `${i}-${line.slice(0, 50)}`;
          return (
            <div key={key} className={`px-2 leading-relaxed ${lineClass}`}>
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
});

/**
 * Render pre-highlighted diff HTML from shiki.
 * Used when diffHtml is available from the augment.
 * Memoized to prevent scroll reset when parent re-renders.
 */
const HighlightedDiff = memo(function HighlightedDiff({
  diffHtml,
  truncateLines,
}: {
  diffHtml: string;
  truncateLines?: number;
}) {
  // If truncation is needed, we need to limit the visible lines
  // The HTML is wrapped in <pre class="shiki"><code>...</code></pre>
  // Each line is a <span class="line ...">...</span>
  const htmlToRender = useMemo(() => {
    if (!truncateLines) return diffHtml;

    // Parse and truncate by counting line spans
    // Match any span with class starting with "line" (e.g. "line", "line line-deleted")
    const lineRegex = /<span class="line[^"]*">/g;
    const matches = [...diffHtml.matchAll(lineRegex)];
    if (matches.length <= truncateLines) return diffHtml;

    // Find the position to truncate at (after truncateLines lines)
    const lastMatch = matches[truncateLines - 1];
    if (!lastMatch) return diffHtml;

    // Find the closing </span> for this line
    const startPos = (lastMatch.index ?? 0) + lastMatch[0].length;
    const closeSpanPos = diffHtml.indexOf("</span>", startPos);
    if (closeSpanPos === -1) return diffHtml;

    // Truncate and close tags
    return `${diffHtml.slice(0, closeSpanPos + 7)}</code></pre>`;
  }, [diffHtml, truncateLines]);

  return (
    <div
      className="font-mono [font-size:var(--font-size-base)] leading-relaxed tab-[var(--tab-size)]"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is safe
      dangerouslySetInnerHTML={{ __html: htmlToRender }}
    />
  );
});

/**
 * Render a single diff hunk (without @@ header for cleaner display)
 * Memoized to prevent scroll reset when parent re-renders.
 */
const DiffHunk = memo(function DiffHunk({
  hunk,
}: {
  hunk: PatchHunk;
}) {
  const theme = useResolvedTheme();
  const style = getProviderStyle(theme);
  return (
    <div className="my-2 first:mt-0 rounded overflow-hidden border border-[var(--border-color)]">
      <pre className="m-0 p-0 bg-[var(--bg-code)] overflow-x-auto tab-[var(--tab-size)]">
        {hunk.lines.map((line, i) => {
          const prefix = line[0];
          const lineClass =
            prefix === "-"
              ? `${style.diffRemoved}`
              : prefix === "+"
                ? `${style.diffAdded}`
                : "text-[var(--text-muted)]";
          return (
            <div
              key={`${hunk.oldStart}-${i}`}
              className={`px-2 leading-relaxed ${lineClass}`}
            >
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
});

function RawPatchPreview({
  rawPatch,
  truncateLines,
}: {
  rawPatch: string;
  truncateLines?: number;
}) {
  const preview = useMemo(() => {
    if (!truncateLines) {
      return { text: rawPatch, truncated: false };
    }
    return truncateByLines(rawPatch, truncateLines);
  }, [rawPatch, truncateLines]);

  return (
    <div
      className={`relative ${preview.truncated ? "max-h-[18rem] overflow-hidden" : ""}`}
    >
      <div className="font-mono [font-size:var(--font-size-base)]">
        <pre className="bg-[var(--bg-code)] border border-[var(--border-color)] rounded-md p-3 overflow-x-auto font-mono [font-size:var(--font-size-base)] leading-normal my-2 whitespace-pre-wrap break-words tab-[var(--tab-size)]">
          <code>{preview.text}</code>
        </pre>
      </div>
      {preview.truncated && (
        <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-b from-transparent to-[var(--bg-surface)] pointer-events-none" />
      )}
    </div>
  );
}

function RawPatchModalContent({ rawPatch }: { rawPatch: string }) {
  return (
    <div className="bg-[var(--bg-code)] rounded overflow-auto">
      <pre className="bg-[var(--bg-code)] border border-[var(--border-color)] rounded-md p-3 overflow-x-auto font-mono [font-size:var(--font-size-base)] leading-normal my-2 whitespace-pre-wrap break-words tab-[var(--tab-size)]">
        <code>{rawPatch}</code>
      </pre>
    </div>
  );
}

/**
 * Edit tool use - shows file path and diff preview
 * Reads augment data directly from input._structuredPatch and input._diffHtml.
 */
function EditToolUse({
  input,
  provider,
}: {
  input: EditInputWithAugment;
  provider?: string;
}) {
  // Show loading state if augment data not yet available
  if (!input._structuredPatch || input._structuredPatch.length === 0) {
    if (input._rawPatch) {
      return (
        <div className="flex flex-col gap-2">
          <RawPatchPreview rawPatch={input._rawPatch} />
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-2">
        <div className="text-[var(--text-muted)] italic [font-size:var(--font-size-lg)]">
          Computing diff...
        </div>
      </div>
    );
  }

  const diffLines = input._structuredPatch.flatMap((hunk) => hunk.lines);
  const changeSummary = computeChangeSummary(input._structuredPatch);
  const isTruncated = diffLines.length > MAX_VISIBLE_LINES;

  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      {changeSummary && (
        <div className="text-[var(--text-muted,#888)] [font-size:var(--font-size-base)]">
          {changeSummary}
        </div>
      )}
      <div
        className={`relative ${isTruncated ? "max-h-[18rem] overflow-hidden" : ""}`}
      >
        <div className="font-mono [font-size:var(--font-size-base)]">
          {input._diffHtml ? (
            <HighlightedDiff
              diffHtml={input._diffHtml}
              truncateLines={isTruncated ? MAX_VISIBLE_LINES : undefined}
            />
          ) : (
            <DiffLines lines={diffLines} />
          )}
        </div>
        {isTruncated && (
          <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-b from-transparent to-[var(--bg-surface)] pointer-events-none" />
        )}
      </div>
    </div>
  );
}

/**
 * Get relative file path by stripping project path prefix
 */
function getRelativePath(filePath: string, projectPath: string | null): string {
  if (projectPath && filePath.startsWith(projectPath)) {
    // Strip project path and leading slash
    const relative = filePath.slice(projectPath.length);
    return relative.startsWith("/") ? relative.slice(1) : relative;
  }
  return filePath;
}

/**
 * Modal content for viewing complete diff with optional full file context.
 * Full context toggle is only available when originalFile is provided.
 */
function DiffModalContent({
  diffHtml,
  structuredPatch,
  filePath,
  oldString,
  newString,
  originalFile,
  replaceAll,
  provider,
}: {
  diffHtml?: string;
  structuredPatch: PatchHunk[];
  filePath: string;
  oldString: string;
  newString: string;
  /** Complete file content from SDK Edit result (never truncated). Null for file creation. */
  originalFile?: string | null;
  replaceAll?: boolean;
  provider?: string;
}) {
  const { projectPath } = useSessionMetadata();
  const [showFullContext, setShowFullContext] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Only fetch expanded diff when originalFile is available (not for file creation)
  // The SDK's originalFile is never truncated - it's the complete file content.
  const canExpandContext = !!originalFile;
  const { loading, error, result, fetchExpandedDiff } = useExpandedDiff({
    filePath,
    oldString,
    newString,
    originalFile: originalFile ?? "", // Empty string won't be used if canExpandContext is false
    structuredPatch,
    replaceAll,
  });

  const handleToggle = useCallback(async () => {
    if (!canExpandContext) return;
    if (!showFullContext && !result) {
      await fetchExpandedDiff();
    }
    setShowFullContext(!showFullContext);
  }, [canExpandContext, showFullContext, result, fetchExpandedDiff]);

  // Scroll to the first changed line when showing full context
  useEffect(() => {
    if (showFullContext && result && contentRef.current) {
      // Wait for DOM to update with new content
      requestAnimationFrame(() => {
        const firstChange = contentRef.current?.querySelector(
          ".line-deleted, .line-inserted",
        );
        if (firstChange) {
          firstChange.scrollIntoView({ block: "center", behavior: "instant" });
        }
      });
    }
  }, [showFullContext, result]);

  // Use expanded result when showing full context
  const displayHtml =
    showFullContext && result?.diffHtml ? result.diffHtml : diffHtml;
  const displayPatch =
    showFullContext && result?.structuredPatch
      ? result.structuredPatch
      : structuredPatch;

  // Strip project path prefix for display
  const displayPath = getRelativePath(filePath, projectPath);

  return (
    <div className="bg-[var(--bg-code)] rounded overflow-auto" ref={contentRef}>
      <div className="flex gap-2 items-center mb-3 p-2 bg-[var(--bg-secondary)] border-b border-[var(--border-color)] sticky top-0 z-[1]">
        <span className="flex-1 font-mono [font-size:var(--font-size-sm)] text-[var(--text-secondary)] overflow-hidden text-ellipsis whitespace-nowrap">
          {displayPath}
        </span>
        {canExpandContext && (
          <button
            type="button"
            className="px-3 py-1 [font-size:var(--font-size-base)] bg-[var(--bg-surface)] border border-[var(--border-color)] rounded cursor-pointer text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-60 disabled:cursor-wait"
            onClick={handleToggle}
            disabled={loading}
          >
            {loading
              ? "Loading..."
              : showFullContext
                ? "Show diff only"
                : "Show full context"}
          </button>
        )}
        {error && (
          <span className="text-[var(--text-error)] [font-size:var(--font-size-sm)]">
            {error}
          </span>
        )}
      </div>

      {displayHtml ? (
        <HighlightedDiff diffHtml={displayHtml} />
      ) : (
        <DiffLines lines={displayPatch.flatMap((h) => h.lines)} />
      )}
    </div>
  );
}

/**
 * Collapsed preview showing diff with expand button
 * Clicking opens a modal with the full diff.
 * Reads augment data directly from input._structuredPatch and input._diffHtml.
 */
function EditCollapsedPreview({
  input,
  result,
  isError,
  provider,
}: {
  input: EditInputWithAugment;
  result: EditResult | undefined;
  isError: boolean;
  provider?: string;
}) {
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const { projectId, sessionId } = useSessionMetadata();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("Edit", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Edit", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Edit");
  const replaceAll = result?.replaceAll ?? input?.replace_all ?? false;

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

  // Use result data if available, fall back to input
  const filePath = getEditFilePath(input, result);
  const fileName = getFileName(filePath);
  const editorPath = buildEditorPath({
    basePath,
    projectId,
    sessionId,
    filePath,
  });
  const oldString = result?.oldString ?? input.old_string;
  const newString = result?.newString ?? input.new_string;
  const originalFile = result?.originalFile;

  // Get structuredPatch - prefer result, then input augment
  const structuredPatch =
    result?.structuredPatch ?? input._structuredPatch ?? [];

  // Get diffHtml from input augment (only used for tool_use display)
  const diffHtml = input._diffHtml;
  const rawPatch = input._rawPatch;

  if (isError) {
    // Extract error message - can be a string or object with content
    let errorMessage: string | null = null;
    if (typeof result === "string") {
      errorMessage = result;
    } else if (typeof result === "object" && result !== null) {
      const errorResult = result as { content?: unknown };
      if (errorResult.content) {
        errorMessage = String(errorResult.content);
      }
    }

    // Classify the error for appropriate styling
    const classification = errorMessage
      ? classifyToolError(errorMessage)
      : {
          classification: "unknown" as const,
          label: "Error",
          cleanedMessage: "",
        };
    const classSuffix = getErrorClassSuffix(classification.classification);
    const isRejection = isUserRejection(classification.classification);

    // For user rejections, show the proposed diff alongside the declined badge
    const hasProposedDiff =
      isRejection &&
      input._structuredPatch &&
      input._structuredPatch.length > 0;
    const proposedDiffLines = hasProposedDiff
      ? (input._structuredPatch?.flatMap((hunk) => hunk.lines) ?? [])
      : [];
    const proposedDiffTruncated = proposedDiffLines.length > MAX_VISIBLE_LINES;

    return (
      <>
        <div
          className={`flex flex-col gap-2 ${classSuffix === "error" ? "p-2" : classSuffix === "warning" ? "p-2" : classSuffix === "muted" ? "p-2" : ""}`}
        >
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Edit" errors={validationErrors} />
          )}
          <span
            className={`inline-block px-2 py-0.5 rounded [font-size:var(--font-size-sm)] font-medium align-middle ${classSuffix === "warning" ? "bg-[var(--bg-warning,rgba(154,103,0,0.15))] text-[var(--warning-color)]" : classSuffix === "error" ? "bg-[var(--bg-error,rgba(207,34,46,0.15))] text-[var(--error-color)]" : "bg-[var(--bg-secondary)] text-[var(--text-muted)]"}`}
          >
            {isRejection
              ? classification.label
              : `Edit ${classification.label.toLowerCase()}`}
          </span>
          {classification.userReason ? (
            <span className="text-[var(--text-secondary)] mt-2 [font-size:var(--font-size-lg)]">
              {classification.userReason}
            </span>
          ) : classification.cleanedMessage && !isRejection ? (
            <span className="text-[var(--text-secondary)] mt-2 [font-size:var(--font-size-lg)]">
              {classification.cleanedMessage}
            </span>
          ) : null}
          {hasProposedDiff && (
            <div
              className={`relative ${proposedDiffTruncated ? "max-h-[18rem] overflow-hidden" : ""}`}
            >
              <div className="font-mono [font-size:var(--font-size-base)]">
                {input._diffHtml ? (
                  <HighlightedDiff
                    diffHtml={input._diffHtml}
                    truncateLines={
                      proposedDiffTruncated ? MAX_VISIBLE_LINES : undefined
                    }
                  />
                ) : (
                  <DiffLines lines={proposedDiffLines} />
                )}
              </div>
              {proposedDiffTruncated && (
                <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-b from-transparent to-[var(--bg-surface)] pointer-events-none" />
              )}
            </div>
          )}
          {hasProposedDiff && proposedDiffTruncated && (
            <button
              type="button"
              className="absolute bottom-2 right-2 px-3 py-1 bg-[var(--primary-color)] text-white border-none rounded [font-size:var(--font-size-sm)] cursor-pointer opacity-0 transition-opacity duration-150 z-10 pointer-events-auto hover:bg-[var(--link-color)]"
              onClick={(e) => {
                e.stopPropagation();
                setIsModalOpen(true);
              }}
            >
              Show full diff
            </button>
          )}
        </div>
        {isModalOpen && hasProposedDiff && (
          <Modal
            title={
              <span className="font-mono [font-size:var(--font-size-base)] text-[var(--link-color)] break-all">
                {fileName}
              </span>
            }
            onClose={handleClose}
          >
            <DiffModalContent
              diffHtml={diffHtml}
              structuredPatch={structuredPatch}
              filePath={filePath}
              oldString={oldString}
              newString={newString}
              replaceAll={replaceAll}
              provider={provider}
            />
          </Modal>
        )}
      </>
    );
  }

  // Pending edit without augment data yet
  if (structuredPatch.length === 0) {
    if (result === undefined) {
      return (
        <div className="flex flex-col gap-2">
          <div className="text-[var(--text-muted)] italic [font-size:var(--font-size-lg)]">
            Computing diff...
          </div>
        </div>
      );
    }

    if (rawPatch) {
      const rawPatchPreview = truncateByLines(rawPatch, MAX_VISIBLE_LINES);
      return (
        <>
          <div className="flex flex-col gap-2">
            {showValidationWarning && validationErrors && (
              <SchemaWarning toolName="Edit" errors={validationErrors} />
            )}
            <RawPatchPreview
              rawPatch={rawPatch}
              truncateLines={MAX_VISIBLE_LINES}
            />
            {rawPatchPreview.truncated && (
              <button
                type="button"
                className="absolute bottom-2 right-2 px-3 py-1 bg-[var(--primary-color)] text-white border-none rounded [font-size:var(--font-size-sm)] cursor-pointer opacity-0 transition-opacity duration-150 z-10 pointer-events-auto hover:bg-[var(--link-color)]"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsModalOpen(true);
                }}
              >
                Show full patch
              </button>
            )}
          </div>
          {isModalOpen && (
            <Modal
              title={
                <span className="font-mono [font-size:var(--font-size-base)] text-[var(--link-color)] break-all">
                  {fileName}
                </span>
              }
              onClose={handleClose}
            >
              <RawPatchModalContent rawPatch={rawPatch} />
            </Modal>
          )}
        </>
      );
    }

    return (
      <div className="flex flex-col gap-2">
        <span>Patch preview unavailable</span>
      </div>
    );
  }

  const diffLines = structuredPatch.flatMap((hunk) => hunk.lines);
  const isTruncated = diffLines.length > MAX_VISIBLE_LINES;

  return (
    <>
      <div className="flex flex-col gap-3 px-3 py-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {result?.userModified && (
              <span className="inline-block rounded bg-[var(--bg-secondary)] px-2 py-0.5 align-middle [font-size:var(--font-size-sm)] font-medium text-[var(--link-color)]">
                User modified
              </span>
            )}
            {showValidationWarning && validationErrors && (
              <SchemaWarning toolName="Edit" errors={validationErrors} />
            )}
          </div>
          {editorPath && (
            <button
              type="button"
              className="inline-flex shrink-0 items-center rounded-sm border border-[var(--outline-variant)] bg-[var(--surface-container-lowest)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--on-surface)] transition-colors hover:bg-[var(--surface-container-high)]"
              onClick={(e) => {
                e.stopPropagation();
                navigate(editorPath);
              }}
            >
              Open in Editor
            </button>
          )}
        </div>
        <div
          className={`relative ${isTruncated ? "max-h-[18rem] overflow-hidden" : ""}`}
        >
          <div className="font-mono [font-size:var(--font-size-base)]">
            {diffHtml ? (
              <HighlightedDiff
                diffHtml={diffHtml}
                truncateLines={isTruncated ? MAX_VISIBLE_LINES : undefined}
              />
            ) : (
              <DiffLines lines={diffLines} />
            )}
          </div>
          {isTruncated && (
            <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-b from-transparent to-[var(--bg-surface)] pointer-events-none" />
          )}
        </div>
        {isTruncated && (
          <button
            type="button"
            className="absolute bottom-2 right-2 px-3 py-1 bg-[var(--primary-color)] text-white border-none rounded [font-size:var(--font-size-sm)] cursor-pointer opacity-0 transition-opacity duration-150 z-10 pointer-events-auto hover:bg-[var(--link-color)]"
            onClick={handleClick}
          >
            Show full diff
          </button>
        )}
      </div>
      {isModalOpen && (
        <Modal
          title={
            <span className="font-mono [font-size:var(--font-size-base)] text-[var(--link-color)] break-all">
              {fileName}
            </span>
          }
          onClose={handleClose}
        >
          <DiffModalContent
            diffHtml={diffHtml}
            structuredPatch={structuredPatch}
            filePath={filePath}
            oldString={oldString}
            newString={newString}
            originalFile={originalFile}
            replaceAll={replaceAll}
            provider={provider}
          />
        </Modal>
      )}
    </>
  );
}

/**
 * Interactive summary for Edit tool - shows filename and change summary inline
 * Similar to Read tool's interactive summary
 */
function EditInteractiveSummary({
  input,
  result,
  isError,
  provider,
}: {
  input: EditInputWithAugment;
  result: EditResult | undefined;
  isError: boolean;
  provider?: string;
}) {
  const [showModal, setShowModal] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("Edit", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Edit", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Edit");

  const filePath = getEditFilePath(input, result);
  const fileName = getFileName(filePath);
  const oldString = result?.oldString ?? input.old_string;
  const newString = result?.newString ?? input.new_string;
  const originalFile = result?.originalFile;

  // Get structuredPatch - prefer result, then input augment
  const structuredPatch =
    result?.structuredPatch ?? input._structuredPatch ?? [];
  const diffHtml = input._diffHtml;
  const changeSummary = computeChangeSummary(structuredPatch);

  if (isError) {
    return (
      <span>
        {fileName}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Edit" errors={validationErrors} />
        )}
      </span>
    );
  }

  // Show loading state if no patch yet
  if (structuredPatch.length === 0) {
    return <span>{fileName}</span>;
  }

  return (
    <>
      <button
        type="button"
        className="inline-flex items-center gap-2 bg-transparent border-none p-0 font-mono text-inherit text-[var(--link-color)] cursor-pointer underline underline-transparent hover:underline-current"
        onClick={(e) => {
          e.stopPropagation();
          setShowModal(true);
        }}
      >
        {fileName}
        {changeSummary && (
          <span className="text-[var(--text-muted)] text-[0.85em] no-underline">
            {changeSummary}
          </span>
        )}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Edit" errors={validationErrors} />
        )}
      </button>
      {showModal && (
        <Modal
          title={
            <span className="font-mono [font-size:var(--font-size-base)] text-[var(--link-color)] break-all">
              {fileName}
            </span>
          }
          onClose={() => setShowModal(false)}
        >
          <DiffModalContent
            diffHtml={diffHtml}
            structuredPatch={structuredPatch}
            filePath={filePath}
            oldString={oldString}
            newString={newString}
            originalFile={originalFile}
            provider={provider}
          />
        </Modal>
      )}
    </>
  );
}

/**
 * Edit tool result - shows diff view with truncation and modal expand
 */
function EditToolResult({
  result,
  input,
  isError,
  provider,
}: {
  result: EditResult;
  input?: EditInput;
  isError: boolean;
  provider?: string;
}) {
  const [showModal, setShowModal] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("Edit", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Edit", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Edit");
  const replaceAll = result?.replaceAll ?? input?.replace_all ?? false;

  // Count total lines in all hunks
  const totalLines = useMemo(() => {
    if (!result?.structuredPatch) return 0;
    return result.structuredPatch.reduce(
      (sum, hunk) => sum + hunk.lines.length + 1, // +1 for hunk header
      0,
    );
  }, [result?.structuredPatch]);

  const isTruncated = totalLines > MAX_VISIBLE_LINES;

  // Compute change summary
  const changeSummary = useMemo(() => {
    if (!result?.structuredPatch) return null;
    const additions = result.structuredPatch
      .flatMap((h) => h.lines)
      .filter((l) => l.startsWith("+")).length;
    const deletions = result.structuredPatch
      .flatMap((h) => h.lines)
      .filter((l) => l.startsWith("-")).length;

    if (additions > 0 && deletions > 0) {
      return `Modified ${additions + deletions} lines`;
    }
    if (additions > 0) {
      return `Added ${additions} line${additions !== 1 ? "s" : ""}`;
    }
    if (deletions > 0) {
      return `Removed ${deletions} line${deletions !== 1 ? "s" : ""}`;
    }
    return null;
  }, [result?.structuredPatch]);

  if (isError) {
    // Extract error message - can be a string or object with content
    let errorMessage: string | null = null;
    if (typeof result === "string") {
      errorMessage = result;
    } else if (typeof result === "object" && result !== null) {
      const errorResult = result as { content?: unknown };
      if (errorResult.content) {
        errorMessage = String(errorResult.content);
      }
    }

    // Classify the error for appropriate styling
    const classification = errorMessage
      ? classifyToolError(errorMessage)
      : {
          classification: "unknown" as const,
          label: "Error",
          cleanedMessage: "",
        };
    const classSuffix = getErrorClassSuffix(classification.classification);
    const isRejection = isUserRejection(classification.classification);

    // For user rejections, show the proposed diff alongside the declined badge
    const inputWithAugment = input as EditInputWithAugment | undefined;
    const hasProposedDiff =
      isRejection &&
      inputWithAugment?._structuredPatch &&
      inputWithAugment._structuredPatch.length > 0;
    const proposedDiffLines = hasProposedDiff
      ? (inputWithAugment._structuredPatch?.flatMap((hunk) => hunk.lines) ?? [])
      : [];
    const proposedDiffTruncated = proposedDiffLines.length > MAX_VISIBLE_LINES;

    const filePath = getEditFilePath(inputWithAugment);
    const fileName = getFileName(filePath);

    return (
      <>
        <div
          className={`flex flex-col gap-2 ${classSuffix === "error" ? "p-2" : classSuffix === "warning" ? "p-2" : classSuffix === "muted" ? "p-2" : ""}`}
        >
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Edit" errors={validationErrors} />
          )}
          <span
            className={`inline-block px-2 py-0.5 rounded [font-size:var(--font-size-sm)] font-medium align-middle ${classSuffix === "warning" ? "bg-[var(--bg-warning,rgba(154,103,0,0.15))] text-[var(--warning-color)]" : classSuffix === "error" ? "bg-[var(--bg-error,rgba(207,34,46,0.15))] text-[var(--error-color)]" : "bg-[var(--bg-secondary)] text-[var(--text-muted)]"}`}
          >
            {isRejection
              ? classification.label
              : `Edit ${classification.label.toLowerCase()}`}
          </span>
          {classification.userReason ? (
            <div className="text-[var(--text-secondary)] mt-2 [font-size:var(--font-size-lg)]">
              {classification.userReason}
            </div>
          ) : classification.cleanedMessage && !isRejection ? (
            <div className="text-[var(--text-secondary)] mt-2 [font-size:var(--font-size-lg)]">
              {classification.cleanedMessage}
            </div>
          ) : null}
          {hasProposedDiff && (
            <div
              className={`relative ${proposedDiffTruncated ? "max-h-[18rem] overflow-hidden" : ""}`}
            >
              <div className="font-mono [font-size:var(--font-size-base)]">
                {inputWithAugment?._diffHtml ? (
                  <HighlightedDiff
                    diffHtml={inputWithAugment._diffHtml}
                    truncateLines={
                      proposedDiffTruncated ? MAX_VISIBLE_LINES : undefined
                    }
                  />
                ) : (
                  <DiffLines lines={proposedDiffLines} />
                )}
              </div>
              {proposedDiffTruncated && (
                <>
                  <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-b from-transparent to-[var(--bg-surface)] pointer-events-none" />
                  <button
                    type="button"
                    className="absolute bottom-2 right-2 px-3 py-1 bg-[var(--primary-color)] text-white border-none rounded [font-size:var(--font-size-sm)] cursor-pointer opacity-0 transition-opacity duration-150 z-10 pointer-events-auto hover:bg-[var(--link-color)]"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowModal(true);
                    }}
                  >
                    Show full diff
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        {showModal && hasProposedDiff && inputWithAugment && (
          <Modal
            title={
              <span className="font-mono [font-size:var(--font-size-base)] text-[var(--link-color)] break-all">
                {fileName}
              </span>
            }
            onClose={() => setShowModal(false)}
          >
            <DiffModalContent
              diffHtml={inputWithAugment._diffHtml}
              structuredPatch={inputWithAugment._structuredPatch ?? []}
              filePath={filePath}
              oldString={inputWithAugment.old_string}
              newString={inputWithAugment.new_string}
              replaceAll={inputWithAugment.replace_all ?? false}
            />
          </Modal>
        )}
      </>
    );
  }

  // Handle case where result doesn't have structuredPatch
  // Use input data as fallback when result data is missing
  if (!result?.structuredPatch || result.structuredPatch.length === 0) {
    const filePath = getEditFilePath(input, result);
    const oldString = result?.oldString || input?.old_string || "";
    const newString = result?.newString || input?.new_string || "";
    const isPlan = filePath ? isPlanFile(filePath) : false;

    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-mono [font-size:var(--font-size-base)] text-[var(--link-color)] break-all">
            {filePath ? getFileName(filePath) : "File"}
          </span>
          {isPlan && (
            <span className="inline-block px-2 py-0.5 rounded [font-size:var(--font-size-sm)] font-medium align-middle bg-[var(--bg-secondary)] text-[var(--text-muted)]">
              Plan
            </span>
          )}
          {result?.userModified && (
            <span className="inline-block px-2 py-0.5 rounded [font-size:var(--font-size-sm)] font-medium align-middle bg-[var(--bg-secondary)] text-[var(--link-color)]">
              User modified
            </span>
          )}
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Edit" errors={validationErrors} />
          )}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-2">
            <div className="text-[var(--text-muted)] [font-size:var(--font-size-sm)] mb-1">
              Removed:
            </div>
            <pre className="bg-[var(--bg-code)] border border-[var(--border-color)] rounded-md p-3 overflow-x-auto font-mono [font-size:var(--font-size-base)] leading-normal my-2 whitespace-pre-wrap break-words tab-[var(--tab-size)]">
              <code>{oldString || "(empty)"}</code>
            </pre>
          </div>
          <div className="flex flex-col gap-2">
            <div className="text-[var(--text-muted)] [font-size:var(--font-size-sm)] mb-1">
              Added:
            </div>
            <pre className="bg-[var(--bg-code)] border border-[var(--border-color)] rounded-md p-3 overflow-x-auto font-mono [font-size:var(--font-size-base)] leading-normal my-2 whitespace-pre-wrap break-words tab-[var(--tab-size)]">
              <code>{newString || "(empty)"}</code>
            </pre>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Edit" errors={validationErrors} />
        )}
        {changeSummary && (
          <div className="text-[var(--text-muted,#888)] [font-size:var(--font-size-base)]">
            {changeSummary}
          </div>
        )}
        {result.userModified && (
          <span className="inline-block px-2 py-0.5 rounded [font-size:var(--font-size-sm)] font-medium align-middle bg-[var(--bg-secondary)] text-[var(--link-color)]">
            User modified
          </span>
        )}
        <div
          className={`relative ${isTruncated ? "max-h-[18rem] overflow-hidden" : ""}`}
        >
          <div className="font-mono [font-size:var(--font-size-base)]">
            {result.structuredPatch.map((hunk, i) => (
              <DiffHunk key={`hunk-${hunk.oldStart}-${i}`} hunk={hunk} />
            ))}
          </div>
          {isTruncated && (
            <>
              <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-b from-transparent to-[var(--bg-surface)] pointer-events-none" />
              <button
                type="button"
                className="absolute bottom-2 right-2 px-3 py-1 bg-[var(--primary-color)] text-white border-none rounded [font-size:var(--font-size-sm)] cursor-pointer opacity-0 transition-opacity duration-150 z-10 pointer-events-auto hover:bg-[var(--link-color)]"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowModal(true);
                }}
              >
                Click to expand
              </button>
            </>
          )}
        </div>
      </div>
      {showModal && (
        <Modal
          title={
            <span className="font-mono [font-size:var(--font-size-base)] text-[var(--link-color)] break-all">
              {getFileName(result.filePath)}
            </span>
          }
          onClose={() => setShowModal(false)}
        >
          <DiffModalContent
            structuredPatch={result.structuredPatch}
            filePath={result.filePath}
            oldString={result.oldString ?? input?.old_string ?? ""}
            newString={result.newString ?? input?.new_string ?? ""}
            originalFile={result.originalFile}
            replaceAll={replaceAll}
          />
        </Modal>
      )}
    </>
  );
}

export const editRenderer: ToolRenderer<EditInput, EditResult> = {
  tool: "Edit",

  renderToolUse(input, context) {
    return (
      <EditToolUse
        input={input as EditInputWithAugment}
        provider={context?.provider}
      />
    );
  },

  renderToolResult(result, isError, context, input) {
    return (
      <EditToolResult
        result={result as EditResult}
        input={input as EditInput | undefined}
        isError={isError}
        provider={context?.provider}
      />
    );
  },

  getUseSummary(input) {
    return getFileName(getEditFilePath(input as EditInputWithAugment));
  },

  getResultSummary(result, isError) {
    if (isError) {
      // Extract error message for classification
      let errorMessage: string | null = null;
      if (typeof result === "string") {
        errorMessage = result;
      } else if (typeof result === "object" && result !== null) {
        const errorResult = result as { content?: unknown };
        if (errorResult.content) {
          errorMessage = String(errorResult.content);
        }
      }
      if (errorMessage) {
        const classification = classifyToolError(errorMessage);
        return classification.label;
      }
      return "Error";
    }
    const r = result as EditResult;
    return r?.filePath ? getFileName(r.filePath) : "file";
  },

  renderCollapsedPreview(input, result, isError, context) {
    return (
      <EditCollapsedPreview
        input={input as EditInputWithAugment}
        result={result as EditResult | undefined}
        isError={isError}
        provider={context?.provider}
      />
    );
  },

  renderInteractiveSummary(input, result, isError, context) {
    return (
      <EditInteractiveSummary
        input={input as EditInputWithAugment}
        result={result as EditResult | undefined}
        isError={isError}
        provider={context?.provider}
      />
    );
  },
};
