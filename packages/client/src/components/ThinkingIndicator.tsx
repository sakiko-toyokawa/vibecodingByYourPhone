/**
 * Unified thinking/running indicator component.
 * Use this for all "thinking", "running", or "processing" state indicators.
 *
 * Variants:
 * - "dot": Compact pulsing dot only (8x8px)
 * - "pill": Pill badge with pulsing dot and text label
 *
 * Examples:
 *   <ThinkingIndicator />                    // Just a pulsing dot
 *   <ThinkingIndicator variant="pill" />     // Pill with "Thinking" text
 *   <ThinkingIndicator variant="pill" label="Running" />
 */

interface ThinkingIndicatorProps {
  /** Visual variant - "dot" for compact, "pill" for badge with text */
  variant?: "dot" | "pill";
  /** Text label for pill variant (default: "Thinking") */
  label?: string;
  /** Optional className for additional styling */
  className?: string;
}

export function ThinkingIndicator({
  variant = "dot",
  label = "Thinking",
  className,
}: ThinkingIndicatorProps) {
  const dot = (
    <span className="inline-flex items-center justify-center">
      <span className="h-2 w-2 rounded-full bg-[var(--thinking-color)] animate-[thinking-pulse_1.5s_ease-in-out_infinite]" />
    </span>
  );

  if (variant === "pill") {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-0.5 text-[10px] font-medium whitespace-nowrap text-[var(--thinking-color)] ${className ?? ""}`}
        style={{
          background:
            "color-mix(in srgb, var(--thinking-color) 15%, transparent)",
        }}
      >
        {dot}
        <span className="leading-none">{label}</span>
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center justify-center ${className ?? ""}`}
    >
      {dot}
    </span>
  );
}
