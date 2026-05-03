/**
 * Provider-specific visual styles for tool call cards and diff rendering.
 *
 * Each provider (Claude, Codex, Gemini) gets a distinct color palette
 * that replaces the generic green/red diff colors.
 */

export type ProviderStyle = "claude" | "codex" | "gemini";

export interface ProviderStyleConfig {
  /** Left border accent color (Tailwind class) */
  accent: string;
  /** Card background (Tailwind class) */
  bg: string;
  /** Card shadow (Tailwind class) */
  shadow: string;
  /** Tool label text color (Tailwind class) */
  label: string;
  /** Badge/tag background+text (Tailwind class) */
  badge: string;
  /** Added line background+text (Tailwind class) */
  diffAdded: string;
  /** Removed line background+text (Tailwind class) */
  diffRemoved: string;
  /** Added count text color (Tailwind class) */
  addedCount: string;
  /** Removed count text color (Tailwind class) */
  removedCount: string;
}

/**
 * Normalize provider string to one of the three style categories.
 * Maps sub-variants (claude-ollama, codex-oss, gemini-acp) to their base provider.
 */
export function normalizeProvider(provider?: string): ProviderStyle {
  if (!provider) return "claude";
  if (provider.startsWith("claude")) return "claude";
  if (provider.startsWith("codex")) return "codex";
  if (provider.startsWith("gemini")) return "gemini";
  return "claude";
}

const STYLES: Record<ProviderStyle, ProviderStyleConfig> = {
  claude: {
    accent: "border-l-amber-500",
    bg: "bg-amber-50/30",
    shadow: "shadow-[0_1px_0_rgba(20,20,19,0.03)]",
    label: "text-amber-700",
    badge: "bg-amber-100/70 text-amber-800",
    diffAdded: "bg-amber-100/50 text-amber-950",
    diffRemoved: "bg-rose-100/50 text-rose-800",
    addedCount: "text-emerald-600",
    removedCount: "text-rose-500",
  },
  codex: {
    accent: "border-l-[#004225]",
    bg: "bg-[var(--bg-secondary)]",
    shadow: "",
    label: "text-[#75AF89]",
    badge: "bg-[#004225]/20 text-[#75AF89]",
    diffAdded: "bg-[#004225]/12 text-[#98D4AC]",
    diffRemoved: "bg-transparent text-[var(--text-muted)] line-through",
    addedCount: "text-[#98D4AC]",
    removedCount: "text-[var(--text-muted)]",
  },
  gemini: {
    accent: "border-l-blue-500",
    bg: "bg-blue-50/40",
    shadow: "shadow-[0_1px_0_rgba(20,20,19,0.03)]",
    label: "text-blue-700",
    badge: "bg-blue-100/70 text-blue-800",
    diffAdded: "bg-blue-100/50 text-blue-950",
    diffRemoved: "bg-red-100/50 text-red-700",
    addedCount: "text-green-600",
    removedCount: "text-red-500",
  },
};

/**
 * Get the visual style config for a given provider.
 * Falls back to "claude" style if provider is unrecognized.
 */
export function getProviderStyle(provider?: string): ProviderStyleConfig {
  return STYLES[normalizeProvider(provider)];
}
