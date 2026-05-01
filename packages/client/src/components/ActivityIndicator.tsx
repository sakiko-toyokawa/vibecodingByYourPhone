/**
 * Unified activity indicator component for showing active/running state.
 * Uses semantic CSS with pulsing animation.
 *
 * Variants:
 * - "dot": Compact pulsing dot (default)
 * - "badge": Dot wrapped in a badge container
 */

interface ActivityIndicatorProps {
  /** Visual variant - "dot" for compact, "badge" for wrapped in badge container */
  variant?: "dot" | "badge";
  /** Optional className for additional styling */
  className?: string;
}

export function ActivityIndicator({
  variant = "dot",
  className,
}: ActivityIndicatorProps) {
  const dot = (
    <span className="inline-block w-2 h-2 rounded-full bg-[var(--thinking-color)] animate-[thinking-pulse_1.5s_ease-in-out_infinite]" />
  );

  if (variant === "badge") {
    return (
      <span
        className={`inline-flex items-center justify-center w-5 h-5 rounded-full bg-[var(--bg-hover)] ${className ?? ""}`}
      >
        {dot}
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center ${className ?? ""}`}>{dot}</span>
  );
}
