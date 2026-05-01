import { memo, useCallback, useEffect, useState } from "react";
import { useStreamingMarkdownContext } from "../../contexts/StreamingMarkdownContext";
import { useStreamingMarkdown } from "../../hooks/useStreamingMarkdown";
import { LocalMediaModal, useLocalMediaClick } from "../LocalMediaModal";

interface Props {
  text: string;
  isStreaming?: boolean;
  augmentHtml?: string;
}

const markdownContentClasses =
  "text-[13px] leading-6 text-[var(--text-primary)] [&_p]:mb-3 [&_p:last-child]:mb-0 [&_code]:break-words [&_code]:rounded-[var(--radius-sm)] [&_code]:bg-[var(--bg-code)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:[font-family:var(--font-mono)] [&_code]:text-[0.9em] [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-[var(--radius-md)] [&_pre]:border [&_pre]:border-[var(--border-color)] [&_pre]:bg-[var(--bg-code)] [&_pre]:p-3 [&_pre]:[font-family:var(--font-mono)] [&_pre]:[font-size:var(--font-size-sm)] [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1 [&_a]:text-[var(--link-color)] [&_a]:underline-offset-2 hover:[&_a]:underline [&_blockquote]:my-3 [&_blockquote]:border-l-[3px] [&_blockquote]:border-[var(--border-color)] [&_blockquote]:pl-4 [&_blockquote]:text-[var(--text-muted)] [&_h1]:my-4 [&_h1]:[font-family:var(--font-display)] [&_h1]:text-[1.7rem] [&_h1]:leading-tight [&_h2]:my-4 [&_h2]:[font-family:var(--font-display)] [&_h2]:text-[1.45rem] [&_h2]:leading-tight [&_h3]:my-3 [&_h3]:[font-family:var(--font-display)] [&_h3]:text-[1.2rem] [&_h3]:leading-tight [&_h4]:my-3 [&_h4]:font-semibold [&_h5]:my-3 [&_h5]:font-semibold [&_h6]:my-3 [&_h6]:font-semibold [&_hr]:my-4 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-[var(--border-color)] [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:[font-size:var(--font-size-sm)] [&_th]:border [&_th]:border-[var(--border-color)] [&_th]:bg-[var(--bg-secondary)] [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_td]:border [&_td]:border-[var(--border-color)] [&_td]:px-3 [&_td]:py-2";

export const TextBlock = memo(function TextBlock({
  text,
  isStreaming = false,
  augmentHtml,
}: Props) {
  const [copied, setCopied] = useState(false);
  const streamingMarkdown = useStreamingMarkdown();
  const streamingContext = useStreamingMarkdownContext();
  const [useStreamingContent, setUseStreamingContent] = useState(false);

  useEffect(() => {
    if (!isStreaming || !streamingContext) {
      if (!isStreaming) {
        setUseStreamingContent(false);
        streamingMarkdown.reset();
      }
      return;
    }

    const unregister = streamingContext.registerStreamingHandler({
      onAugment: (augment) => {
        setUseStreamingContent(true);
        streamingMarkdown.onAugment(augment);
      },
      onPending: streamingMarkdown.onPending,
      onStreamEnd: streamingMarkdown.onStreamEnd,
      captureHtml: streamingMarkdown.captureHtml,
    });

    return unregister;
  }, [isStreaming, streamingContext, streamingMarkdown]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy text:", err);
    }
  }, [text]);

  const { modal, handleClick, closeModal } = useLocalMediaClick();
  const showStreamingContent = isStreaming && useStreamingContent;
  const renderStreamingContainer = isStreaming;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click handler intercepts local media links only
    <div
      className="group relative my-2 rounded-lg border border-[var(--border-subtle)] bg-white/85 px-5 py-4 pr-12 shadow-[0_1px_0_rgba(20,20,19,0.03)] backdrop-blur-sm"
      onClick={handleClick}
    >
      <button
        type="button"
        className={`absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-muted)] opacity-0 transition-all duration-150 group-hover:opacity-100 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-border)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ${copied ? "opacity-100 text-[var(--success-color)]" : ""}`}
        onClick={handleCopy}
        title={copied ? "Copied!" : "Copy markdown"}
        aria-label={copied ? "Copied!" : "Copy markdown"}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>

      {renderStreamingContainer && (
        <div style={showStreamingContent ? undefined : { display: "none" }}>
          <div
            ref={streamingMarkdown.containerRef}
            className={markdownContentClasses}
          />
          <span
            ref={streamingMarkdown.pendingRef}
            className={`${markdownContentClasses} opacity-70`}
          />
          {showStreamingContent && (
            <span className="ml-0.5 inline-block h-4 w-px align-middle animate-[blink_0.8s_ease-in-out_infinite] bg-[var(--text-primary)]" />
          )}
        </div>
      )}

      {!showStreamingContent &&
        (augmentHtml ? (
          <div
            className={markdownContentClasses}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
            dangerouslySetInnerHTML={{ __html: augmentHtml }}
          />
        ) : (
          <div className={markdownContentClasses}>
            <p>{text}</p>
          </div>
        ))}
      {modal && (
        <LocalMediaModal
          path={modal.path}
          mediaType={modal.mediaType}
          onClose={closeModal}
        />
      )}
    </div>
  );
});

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5L6.5 12L13 4" />
    </svg>
  );
}
