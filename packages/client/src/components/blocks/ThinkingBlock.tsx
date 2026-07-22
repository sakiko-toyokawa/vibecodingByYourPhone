import { memo } from "react";

interface Props {
  thinking: string;
  status: "streaming" | "complete";
  isExpanded: boolean;
  onToggle: () => void;
}

export const ThinkingBlock = memo(function ThinkingBlock({
  thinking,
  status,
  isExpanded,
  onToggle,
}: Props) {
  const isStreaming = status === "streaming";
  const className = [
    "my-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] shadow-[0_1px_0_rgba(20,20,19,0.03)]",
    isStreaming && !isExpanded ? "animate-pulse" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <details
      className={className}
      open={isExpanded}
      onToggle={(e) => {
        if (e.currentTarget.open !== isExpanded) {
          onToggle();
        }
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2.5 text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--text-secondary)] select-none sm:px-4 sm:py-3 sm:text-[11px]">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3a1.5 1.5 0 0 0 0 3 1.5 1.5 0 0 0 0-3z" />
          <path d="M12 18a1.5 1.5 0 0 0 0 3 1.5 1.5 0 0 0 0-3z" />
          <path d="M3 12a1.5 1.5 0 0 0 3 0 1.5 1.5 0 0 0-3 0z" />
          <path d="M18 12a1.5 1.5 0 0 0 3 0 1.5 1.5 0 0 0-3 0z" />
          <path d="M5.6 5.6a1.5 1.5 0 0 0 2.1 2.1 1.5 1.5 0 0 0-2.1-2.1z" />
          <path d="M16.3 16.3a1.5 1.5 0 0 0 2.1 2.1 1.5 1.5 0 0 0-2.1-2.1z" />
          <path d="M5.6 18.4a1.5 1.5 0 0 0 2.1-2.1 1.5 1.5 0 0 0-2.1 2.1z" />
          <path d="M16.3 7.7a1.5 1.5 0 0 0 2.1-2.1 1.5 1.5 0 0 0-2.1 2.1z" />
        </svg>
        <span className="flex-1">Thinking Process</span>
        <span className="shrink-0 text-[var(--text-dimmed)]">
          <svg
            className={`h-4 w-4 transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`}
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M6 3l5 5-5 5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </summary>
      <div className="border-t border-[var(--border-subtle)] px-4 py-4 sm:px-5">
        <span className="whitespace-pre-wrap [font-family:var(--font-display)] text-[14px] italic leading-7 text-[var(--text-secondary)] sm:text-[15px] sm:leading-8">
          {thinking}
        </span>
      </div>
    </details>
  );
});
