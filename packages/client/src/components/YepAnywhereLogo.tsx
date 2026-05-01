/**
 * YepAnywhereLogo - Brand logo component with dark/light mode support.
 *
 * Displays the yep✓anywhere wordmark with the app icon.
 * Automatically adapts colors based on current theme.
 */

interface YepAnywhereLogoProps {
  /** Show compact version (icon + text) vs just text */
  showIcon?: boolean;
  /** Preset size variant */
  size?: "sm" | "md" | "lg";
  /** Additional className for styling */
  className?: string;
}

export function YepAnywhereLogo({
  showIcon = true,
  size = "md",
  className = "",
}: YepAnywhereLogoProps) {
  const iconSize =
    size === "lg" ? "h-9 w-9" : size === "sm" ? "h-5 w-5" : "h-6 w-6";
  const textSize =
    size === "lg" ? "text-[22px]" : size === "sm" ? "text-[15px]" : "text-base";

  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      {showIcon && (
        <svg
          viewBox="0 0 120 120"
          className={`${iconSize} shrink-0`}
          aria-hidden="true"
        >
          <defs>
            <linearGradient
              id="yepIconGrad"
              x1="0%"
              y1="0%"
              x2="100%"
              y2="100%"
            >
              <stop offset="0%" stopColor="var(--accent-rust)" />
              <stop offset="100%" stopColor="var(--accent-rust-dark)" />
            </linearGradient>
          </defs>
          <rect
            x="0"
            y="0"
            width="120"
            height="120"
            rx="26"
            fill="url(#yepIconGrad)"
          />
          <path
            d="M 28 35 L 50 62 L 92 20"
            fill="none"
            stroke="#ffffff"
            strokeWidth="10"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M 50 62 L 50 95"
            fill="none"
            stroke="#ffffff"
            strokeWidth="10"
            strokeLinecap="round"
          />
        </svg>
      )}
      <span className={`font-sans font-bold tracking-[-0.03em] ${textSize}`}>
        <span className="text-[var(--accent-rust-dark)]">yep</span>
        <span className="text-[var(--text-primary)]">anywhere</span>
      </span>
    </span>
  );
}
