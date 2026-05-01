import type { FileContentResponse } from "@yep-anywhere/shared";
import { memo, useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../i18n";

interface FileViewerProps {
  projectId: string;
  filePath: string;
  onClose?: () => void;
  /** If true, renders as standalone page layout instead of modal content */
  standalone?: boolean;
  /** Line number to scroll to and highlight (1-indexed) */
  lineNumber?: number;
  /** End line for range highlighting (1-indexed). If not provided, only lineNumber is highlighted. */
  lineEnd?: number;
}

/**
 * Format file size for display.
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Get language hint from file extension for potential future syntax highlighting.
 */
function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    swift: "swift",
    php: "php",
    sql: "sql",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    html: "html",
    css: "css",
    scss: "scss",
    md: "markdown",
    markdown: "markdown",
  };
  return langMap[ext] || "plaintext";
}

/**
 * Check if file is an image.
 */
function isImageFile(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/**
 * Check if file is markdown.
 */
function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return ext === "md" || ext === "markdown";
}

/**
 * Get filename from path.
 */
function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

/**
 * FileViewer component - displays file content with appropriate formatting.
 */
export const FileViewer = memo(function FileViewer({
  projectId,
  filePath,
  onClose,
  standalone = false,
  lineNumber,
  lineEnd,
}: FileViewerProps) {
  const { t } = useI18n();
  const [fileData, setFileData] = useState<FileContentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [highlightedLineRef, setHighlightedLineRef] =
    useState<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    // Request highlighting for code files
    api
      .getFile(projectId, filePath, true)
      .then((data) => {
        if (!cancelled) {
          setFileData(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || t("fileViewerLoadFailed" as never));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, filePath, t]);

  // Handle Escape key to exit fullscreen
  useEffect(() => {
    if (!fullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFullscreen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [fullscreen]);

  // Scroll to highlighted line when it's rendered
  useEffect(() => {
    if (highlightedLineRef) {
      // Small delay to ensure layout is complete
      requestAnimationFrame(() => {
        highlightedLineRef.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      });
    }
  }, [highlightedLineRef]);

  const handleCopy = useCallback(async () => {
    if (!fileData?.content) return;
    try {
      await navigator.clipboard.writeText(fileData.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }, [fileData?.content]);

  const handleDownload = useCallback(() => {
    const url = api.getFileRawUrl(projectId, filePath, true);
    window.open(url, "_blank");
  }, [projectId, filePath]);

  const handleOpenInNewTab = useCallback(() => {
    const url = `/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`;
    window.open(url, "_blank");
  }, [projectId, filePath]);

  const fileName = getFileName(filePath);
  const language = getLanguageFromPath(filePath);

  // Render loading state
  if (loading) {
    return (
      <div className="flex flex-col h-full bg-[var(--bg-surface)]">
        <div className="flex items-center justify-center p-8 text-[var(--text-muted)]">
          {t("fileViewerLoading" as never, { name: fileName })}
        </div>
      </div>
    );
  }

  // Render error state
  if (error || !fileData) {
    return (
      <div className="flex flex-col h-full bg-[var(--bg-surface)]">
        <div className="flex items-center justify-center p-8 text-[var(--error-color)]">
          {error || t("fileViewerNotFound" as never)}
        </div>
      </div>
    );
  }

  const { metadata, content, rawUrl } = fileData;
  const isImage = isImageFile(metadata.mimeType);

  // Render content based on file type
  const renderContent = () => {
    // Image files
    if (isImage) {
      return (
        <div className="flex items-center justify-center p-4 min-h-[200px]">
          <img
            src={rawUrl}
            alt={fileName}
            className="max-w-full max-h-[80vh] object-contain rounded"
          />
        </div>
      );
    }

    // Text files
    if (content !== undefined) {
      const isMarkdown = isMarkdownFile(filePath);
      const hasMarkdownPreview = isMarkdown && !!fileData.renderedMarkdownHtml;

      // Toggle button for markdown files
      const toggleButton = hasMarkdownPreview && (
        <div className="flex gap-0 p-2 px-3 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
          <button
            type="button"
            className={`px-3 py-1.5 border border-[var(--border-color)] bg-[var(--bg-surface)] text-[var(--text-muted)] [font-size:var(--font-size-sm)] cursor-pointer transition-all duration-150 hover:bg-[var(--bg-hover)] rounded-l ${!showPreview ? "bg-[var(--primary-color)] text-white border-[var(--primary-color)]" : ""}`}
            onClick={() => setShowPreview(false)}
          >
            {t("fileViewerSource" as never)}
          </button>
          <button
            type="button"
            className={`px-3 py-1.5 border border-[var(--border-color)] bg-[var(--bg-surface)] text-[var(--text-muted)] [font-size:var(--font-size-sm)] cursor-pointer transition-all duration-150 hover:bg-[var(--bg-hover)] rounded-r border-l-0 ${showPreview ? "bg-[var(--primary-color)] text-white border-[var(--primary-color)]" : ""}`}
            onClick={() => setShowPreview(true)}
          >
            {t("fileViewerPreview" as never)}
          </button>
        </div>
      );

      // Show rendered markdown preview
      if (showPreview && fileData.renderedMarkdownHtml) {
        return (
          <>
            {toggleButton}
            <div className="overflow-auto">
              <div
                className="p-4 leading-relaxed text-[var(--text-primary)]"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
                dangerouslySetInnerHTML={{
                  __html: fileData.renderedMarkdownHtml,
                }}
              />
            </div>
          </>
        );
      }

      // Server-rendered syntax highlighting (preferred)
      if (fileData.highlightedHtml) {
        return (
          <>
            {toggleButton}
            <div
              className="font-mono [font-size:var(--font-size-base)] leading-relaxed bg-[var(--bg-code)] overflow-x-auto"
              data-language={fileData.highlightedLanguage ?? language}
            >
              <div
                className="p-3"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
                dangerouslySetInnerHTML={{ __html: fileData.highlightedHtml }}
              />
              {fileData.highlightedTruncated && (
                <div className="py-2 px-3 [font-size:var(--font-size-sm)] text-[var(--text-muted)] border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                  {t("fileViewerHighlightTruncated" as never)}
                </div>
              )}
            </div>
          </>
        );
      }

      // Fallback: plain code (no syntax highlighting available)
      const lines = content.split("\n");
      const highlightStart = lineNumber ?? 0;
      const highlightEnd = lineEnd ?? highlightStart;

      return (
        <>
          {toggleButton}
          <div
            className="font-mono [font-size:var(--font-size-base)] leading-relaxed bg-[var(--bg-code)] overflow-x-auto"
            data-language={language}
          >
            <div className="grid grid-cols-[auto_minmax(0,1fr)] p-1.5 m-0 bg-transparent">
              <div className="text-right pr-4 text-[var(--text-dimmed)] select-none min-w-[2.5em]">
                {lines.map((_, i) => (
                  <div key={`ln-${i + 1}`}>{i + 1}</div>
                ))}
              </div>
              <pre className="m-0 overflow-x-auto leading-relaxed">
                <code>
                  {lines.map((line, i) => {
                    const num = i + 1;
                    const isHighlighted =
                      lineNumber &&
                      num >= highlightStart &&
                      num <= highlightEnd;
                    return (
                      <div
                        key={`line-${i + 1}`}
                        ref={
                          lineNumber && num === highlightStart
                            ? (el) => setHighlightedLineRef(el)
                            : undefined
                        }
                        className={
                          isHighlighted
                            ? "bg-[rgba(255,255,0,0.15)] -mx-3 px-3"
                            : undefined
                        }
                      >
                        {line || " "}
                      </div>
                    );
                  })}
                </code>
              </pre>
            </div>
          </div>
        </>
      );
    }

    // Binary files or files too large
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-8 text-center text-[var(--text-muted)]">
        <p>{t("fileViewerBinary" as never)}</p>
        <p>
          <strong>{t("fileViewerType" as never)}</strong> {metadata.mimeType}
        </p>
        <p>
          <strong>{t("fileViewerSize" as never)}</strong>{" "}
          {formatFileSize(metadata.size)}
        </p>
        <button
          type="button"
          className="px-4 py-2 bg-[var(--primary-color)] text-white border-none rounded [font-size:var(--font-size-base)] cursor-pointer hover:brightness-110"
          onClick={handleDownload}
        >
          {t("fileViewerDownloadFile" as never)}
        </button>
      </div>
    );
  };

  // Header with file info and actions
  const header = (
    <div className="flex items-center justify-between gap-2 py-1.5 px-2 bg-[var(--bg-secondary)] border-b border-[var(--border-color)] flex-shrink-0">
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        <span
          className="font-mono [font-size:var(--font-size-base)] text-[var(--link-color)] break-all"
          title={filePath}
        >
          {filePath}
        </span>
        <span className="[font-size:var(--font-size-sm)] text-[var(--text-muted)]">
          {formatFileSize(metadata.size)}
          {metadata.isText &&
            content &&
            ` \u2022 ${t("fileViewerLines" as never, {
              count: content.split("\n").length,
            })}`}
        </span>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {content && (
          <button
            type="button"
            className={`flex items-center justify-center w-8 h-8 p-0 bg-transparent border-none rounded text-[var(--text-muted)] cursor-pointer transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ${copied ? "text-[var(--success-color)]" : ""}`}
            onClick={handleCopy}
            title={
              copied
                ? t("fileViewerCopied" as never)
                : t("fileViewerCopyContent" as never)
            }
          >
            {copied ? "\u2713" : "\u2398"}
          </button>
        )}
        {!standalone && (
          <button
            type="button"
            className="flex items-center justify-center w-8 h-8 p-0 bg-transparent border-none rounded text-[var(--text-muted)] cursor-pointer transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            onClick={handleOpenInNewTab}
            title={t("fileViewerOpenNewTab" as never)}
          >
            {"\u2197"}
          </button>
        )}
        <button
          type="button"
          className="flex items-center justify-center w-8 h-8 p-0 bg-transparent border-none rounded text-[var(--text-muted)] cursor-pointer transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          onClick={handleDownload}
          title={t("fileViewerDownload" as never)}
        >
          {"\u2913"}
        </button>
        <button
          type="button"
          className="flex items-center justify-center w-8 h-8 p-0 bg-transparent border-none rounded text-[var(--text-muted)] cursor-pointer transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          onClick={() => setFullscreen(!fullscreen)}
          title={
            fullscreen
              ? t("fileViewerExitFullscreen" as never)
              : t("fileViewerFullscreen" as never)
          }
        >
          {fullscreen ? "\u29BE" : "\u26F6"}
        </button>
        {onClose && (
          <button
            type="button"
            className="flex items-center justify-center w-8 h-8 p-0 bg-transparent border-none rounded text-[var(--text-muted)] cursor-pointer transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ml-2"
            onClick={onClose}
            title={t("modalClose")}
          >
            {"\u2715"}
          </button>
        )}
      </div>
    </div>
  );

  const viewerClass = [
    "flex flex-col h-full bg-[var(--bg-surface)]",
    standalone && "min-h-full",
    fullscreen &&
      "fixed inset-0 z-[10000] bg-[var(--bg-surface)] rounded-none max-h-none h-screen w-screen",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={viewerClass}>
      {header}
      <div className="flex-1 overflow-auto p-0">{renderContent()}</div>
    </div>
  );
});
