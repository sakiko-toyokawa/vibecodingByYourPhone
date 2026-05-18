import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { useOptionalSessionMetadata } from "../../../contexts/SessionMetadataContext";
import { useRemoteBasePath } from "../../../hooks/useRemoteBasePath";
import { buildEditorPath } from "../../../lib/editorNavigation";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import { Modal } from "../../ui/Modal";
import type {
  ImageFile,
  PdfFile,
  ReadInput,
  ReadResult,
  TextFile,
  ToolRenderer,
} from "./types";

/** Extended result type with server-rendered syntax highlighting */
interface ReadResultWithAugment extends ReadResult {
  _highlightedContentHtml?: string;
  _highlightedLanguage?: string;
  _highlightedTruncated?: boolean;
  _renderedMarkdownHtml?: string;
  session_id?: string | number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getReadSessionId(result: unknown): string | number | undefined {
  if (!isRecord(result)) {
    return undefined;
  }
  const sessionId = result.session_id;
  if (typeof sessionId === "string" || typeof sessionId === "number") {
    return sessionId;
  }
  return undefined;
}

function isPtyHandoffTextRead(
  result: ReadResultWithAugment | undefined,
): boolean {
  if (!result || result.type !== "text") {
    return false;
  }
  const sessionId = getReadSessionId(result);
  if (sessionId === undefined) {
    return false;
  }
  const file = result.file as TextFile | undefined;
  return !!file && file.content.length === 0;
}

/**
 * Extract filename from path
 */
function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

/**
 * Read tool use - shows file path being read
 */
function ReadToolUse({ input }: { input: ReadInput }) {
  const fileName = getFileName(input.file_path);
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="font-mono [font-size:var(--font-size-base)] text-[var(--link-color)] break-all">
        {fileName}
      </span>
      {(input.offset !== undefined || input.limit !== undefined) && (
        <span className="text-[var(--text-muted)] [font-size:var(--font-size-base)]">
          {input.offset !== undefined && ` from line ${input.offset}`}
          {input.limit !== undefined && ` (${input.limit} lines)`}
        </span>
      )}
    </div>
  );
}

/**
 * Modal content for viewing file contents
 */
function FileModalContent({
  file,
  highlightedHtml,
  highlightedTruncated,
  renderedMarkdownHtml,
}: {
  file: TextFile;
  highlightedHtml?: string;
  highlightedTruncated?: boolean;
  renderedMarkdownHtml?: string;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const lines = (file.content ?? "").split("\n");
  const hasMarkdownPreview = !!renderedMarkdownHtml;

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
  if (showPreview && renderedMarkdownHtml) {
    return (
      <div className="bg-[var(--bg-code)] rounded overflow-auto">
        {toggleButton}
        <div className="overflow-auto">
          <div
            className="p-4 leading-relaxed text-[var(--text-primary)]"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
            dangerouslySetInnerHTML={{ __html: renderedMarkdownHtml }}
          />
        </div>
      </div>
    );
  }

  // Use highlighted HTML if available
  if (highlightedHtml) {
    return (
      <div className="bg-[var(--bg-code)] rounded overflow-auto">
        {toggleButton}
        <div className="font-mono [font-size:var(--font-size-base)] leading-relaxed bg-[var(--bg-code)] overflow-x-auto">
          <div
            className="p-3"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
          {highlightedTruncated && (
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
 * Build modal title for file with optional range info
 */
function FileModalTitle({ file }: { file: TextFile }) {
  const fileName = getFileName(file.filePath);
  const showRange = file.startLine > 1 || file.numLines < file.totalLines;

  return (
    <span className="font-mono [font-size:var(--font-size-base)] text-[var(--link-color)] break-all">
      {fileName}
      {showRange && (
        <span className="text-[var(--text-muted)] [font-size:var(--font-size-sm)]">
          {" "}
          (lines {file.startLine}-{file.startLine + file.numLines - 1} of{" "}
          {file.totalLines})
        </span>
      )}
    </span>
  );
}

/**
 * Text file result - clickable filename that opens modal
 */
function TextFileResult({
  file,
  highlightedHtml,
  highlightedTruncated,
  renderedMarkdownHtml,
  isPtyHandoff = false,
}: {
  file: TextFile;
  highlightedHtml?: string;
  highlightedTruncated?: boolean;
  renderedMarkdownHtml?: string;
  isPtyHandoff?: boolean;
}) {
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const sessionMetadata = useOptionalSessionMetadata();
  const [showModal, setShowModal] = useState(false);
  const fileName = getFileName(file.filePath);
  const showRange = file.startLine > 1 || file.numLines < file.totalLines;
  const editorPath = buildEditorPath({
    basePath,
    projectId: sessionMetadata?.projectId,
    sessionId: sessionMetadata?.sessionId,
    filePath: file.filePath,
  });

  if (isPtyHandoff) {
    return (
      <div className="flex flex-col gap-2">
        <span className="font-mono [font-size:var(--font-size-base)] text-[var(--link-color)] break-all">
          {fileName}
        </span>{" "}
        <span className="text-[var(--text-muted)] ml-auto">
          continues in Shell
        </span>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-3 bg-transparent border border-[var(--border-color)] rounded-lg px-3 py-2 font-mono [font-size:var(--font-size-base)] text-[var(--link-color)] cursor-pointer text-left transition-colors hover:bg-[var(--bg-hover)] hover:border-[var(--border-input)]"
          onClick={() => setShowModal(true)}
        >
          {fileName}
          {showRange && (
            <span className="text-[var(--text-muted)]">
              {" "}
              (lines {file.startLine}-{file.startLine + file.numLines - 1})
            </span>
          )}
          <span className="text-[var(--text-muted)] ml-auto">
            {file.numLines} lines
          </span>
        </button>
        {editorPath && (
          <button
            type="button"
            className="inline-flex w-fit items-center rounded-sm border border-[var(--outline-variant)] bg-[var(--surface-container-lowest)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--on-surface)] transition-colors hover:bg-[var(--surface-container-high)]"
            onClick={() => navigate(editorPath)}
          >
            Open in Editor
          </button>
        )}
      </div>
      {showModal && (
        <Modal
          title={<FileModalTitle file={file} />}
          onClose={() => setShowModal(false)}
        >
          <FileModalContent
            file={file}
            highlightedHtml={highlightedHtml}
            highlightedTruncated={highlightedTruncated}
            renderedMarkdownHtml={renderedMarkdownHtml}
          />
        </Modal>
      )}
    </>
  );
}

/**
 * Image file result - renders as img tag
 */
function ImageFileResult({ file }: { file: ImageFile }) {
  const sizeKB = file.originalSize ? Math.round(file.originalSize / 1024) : 0;
  const { dimensions } = file;
  const hasDimensions =
    dimensions?.originalWidth != null && dimensions?.originalHeight != null;

  return (
    <div className="flex flex-col gap-2">
      {(hasDimensions || sizeKB > 0) && (
        <div className="text-[var(--text-muted)] [font-size:var(--font-size-sm)]">
          {hasDimensions && (
            <>
              {dimensions.originalWidth}x{dimensions.originalHeight}
            </>
          )}
          {hasDimensions && sizeKB > 0 && " "}
          {sizeKB > 0 && <>({sizeKB}KB)</>}
        </div>
      )}
      <img
        className="max-w-full h-auto rounded"
        src={`data:${file.type};base64,${file.base64}`}
        alt="File content"
        width={dimensions?.displayWidth}
        height={dimensions?.displayHeight}
      />
    </div>
  );
}

/**
 * Open base64 PDF data in a new browser tab
 */
function openPdfInNewTab(base64Data: string) {
  const byteChars = atob(base64Data);
  const byteArray = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteArray[i] = byteChars.charCodeAt(i);
  }
  const blob = new Blob([byteArray], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
}

/**
 * PDF file result - button to open in new tab
 */
function PdfFileResult({
  file,
  filePath,
}: { file: PdfFile; filePath?: string }) {
  const sizeKB = file.originalSize ? Math.round(file.originalSize / 1024) : 0;
  const fileName = filePath ? getFileName(filePath) : "document.pdf";

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="inline-flex items-center gap-3 bg-transparent border border-[var(--border-color)] rounded-lg px-3 py-2 font-mono [font-size:var(--font-size-base)] text-[var(--link-color)] cursor-pointer text-left transition-colors hover:bg-[var(--bg-hover)] hover:border-[var(--border-input)]"
        onClick={() => openPdfInNewTab(file.base64)}
      >
        {fileName}
        {sizeKB > 0 && (
          <span className="text-[var(--text-muted)] ml-auto">({sizeKB}KB)</span>
        )}
        <span className="text-[var(--text-muted)] ml-auto">Open PDF</span>
      </button>
    </div>
  );
}

/**
 * Read tool result - dispatches to text or image handler
 */
function ReadToolResult({
  result,
  isError,
}: {
  result: ReadResultWithAugment;
  isError: boolean;
}) {
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("Read", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Read", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Read");

  if (isError || !result?.file) {
    const errorResult = result as unknown as { content?: unknown } | undefined;
    return (
      <div className="text-[var(--error-color)] p-2 bg-[var(--bg-error,rgba(207,34,46,0.1))] rounded">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
        {typeof result === "object" && errorResult?.content
          ? String(errorResult.content)
          : "Failed to read file"}
      </div>
    );
  }

  if (result.type === "pdf") {
    return (
      <>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
        <PdfFileResult file={result.file as PdfFile} />
      </>
    );
  }

  if (result.type === "image") {
    return (
      <>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
        <ImageFileResult file={result.file as ImageFile} />
      </>
    );
  }

  return (
    <>
      {showValidationWarning && validationErrors && (
        <SchemaWarning toolName="Read" errors={validationErrors} />
      )}
      <TextFileResult
        file={result.file as TextFile}
        highlightedHtml={result._highlightedContentHtml}
        highlightedTruncated={result._highlightedTruncated}
        renderedMarkdownHtml={result._renderedMarkdownHtml}
        isPtyHandoff={isPtyHandoffTextRead(result)}
      />
    </>
  );
}

/**
 * Interactive summary for Read tool - clickable filename that opens modal
 */
function ReadInteractiveSummary({
  input,
  result,
  isError,
}: {
  input: ReadInput;
  result: ReadResultWithAugment | undefined;
  isError: boolean;
}) {
  const [showModal, setShowModal] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("Read", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Read", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Read");

  const fileName = getFileName(input.file_path);

  if (isError) {
    return (
      <span>
        {fileName}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
      </span>
    );
  }

  if (!result?.file) {
    return <span>{fileName}</span>;
  }

  if (result.type === "pdf") {
    const pdfFile = result.file as PdfFile;
    return (
      <button
        type="button"
        className="inline-flex items-center gap-2 bg-transparent border-none p-0 font-mono text-inherit text-[var(--link-color)] cursor-pointer underline underline-transparent hover:underline-current"
        onClick={(e) => {
          e.stopPropagation();
          openPdfInNewTab(pdfFile.base64);
        }}
      >
        {fileName}
        <span className="text-[var(--text-muted)] text-[0.85em] no-underline">
          (PDF)
        </span>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
      </button>
    );
  }

  if (result.type === "image") {
    const imageFile = result.file as ImageFile;
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
          <span className="text-[var(--text-muted)] text-[0.85em] no-underline">
            (image)
          </span>
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Read" errors={validationErrors} />
          )}
        </button>
        {showModal && (
          <Modal title={fileName} onClose={() => setShowModal(false)}>
            <ImageFileResult file={imageFile} />
          </Modal>
        )}
      </>
    );
  }

  const file = result.file as TextFile;
  const isPtyHandoff = isPtyHandoffTextRead(result);

  if (isPtyHandoff) {
    return (
      <span>
        {fileName}{" "}
        <span className="text-[var(--text-muted)] text-[0.85em] no-underline">
          continues in Shell
        </span>
      </span>
    );
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
        <span className="text-[var(--text-muted)] text-[0.85em] no-underline">
          {file.numLines} lines
        </span>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Read" errors={validationErrors} />
        )}
      </button>
      {showModal && (
        <Modal
          title={<FileModalTitle file={file} />}
          onClose={() => setShowModal(false)}
        >
          <FileModalContent
            file={file}
            highlightedHtml={result._highlightedContentHtml}
            highlightedTruncated={result._highlightedTruncated}
            renderedMarkdownHtml={result._renderedMarkdownHtml}
          />
        </Modal>
      )}
    </>
  );
}

export const readRenderer: ToolRenderer<ReadInput, ReadResult> = {
  tool: "Read",

  renderToolUse(input, _context) {
    return <ReadToolUse input={input as ReadInput} />;
  },

  renderToolResult(result, isError, _context) {
    return (
      <ReadToolResult
        result={result as ReadResultWithAugment}
        isError={isError}
      />
    );
  },

  getUseSummary(input) {
    return getFileName((input as ReadInput).file_path);
  },

  getResultSummary(result, isError, input?) {
    if (isError && input) return getFileName((input as ReadInput).file_path);
    if (isError) return "Error";
    const r = result as ReadResultWithAugment;
    if (!r?.file) return "Reading...";
    if (isPtyHandoffTextRead(r)) return "continues in Shell";
    if (r.type === "pdf") return "PDF";
    if (r.type === "image") return "Image";
    return getFileName((r.file as TextFile).filePath);
  },

  renderInteractiveSummary(input, result, isError, _context) {
    return (
      <ReadInteractiveSummary
        input={input as ReadInput}
        result={result as ReadResultWithAugment | undefined}
        isError={isError}
      />
    );
  },
};
