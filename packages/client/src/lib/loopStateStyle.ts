import type { RunState } from "@yep-anywhere/shared";

/**
 * Badge color classes for loop run states.
 * Shared by the loops list and loop detail pages.
 */
export function runStateBadgeClass(state: RunState | string): string {
  switch (state) {
    case "active":
      return "bg-[var(--status-badge-running-bg)] text-[var(--status-badge-running-text)]";
    case "needs_human":
      return "bg-[var(--status-badge-input-bg)] text-[var(--status-badge-input-text)]";
    case "complete":
      return "bg-[var(--status-badge-idle-bg)] text-[var(--status-badge-idle-text)]";
    case "failed":
    case "budget_limited":
      return "bg-[var(--error-color)]/15 text-[var(--error-color)]";
    case "paused":
    case "retry":
      return "bg-[var(--warning-color)]/15 text-[var(--warning-color)]";
    default:
      return "bg-[var(--bg-hover)] text-[var(--text-muted)]";
  }
}
