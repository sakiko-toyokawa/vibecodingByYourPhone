import { useTheme } from "../hooks/useTheme";

const THEME_COLORS: Record<string, string> = {
  claude: "var(--app-claude-orange)",
  codex: "#00e290",
  gemini: "#005bc0",
};

const NEXT_THEME: Record<string, string> = {
  claude: "codex",
  codex: "gemini",
  gemini: "claude",
};

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <button
      type="button"
      onClick={() =>
        setTheme(NEXT_THEME[theme] as "claude" | "codex" | "gemini")
      }
      className="flex shrink-0 items-center gap-1.5 rounded-sm px-2 py-1 text-sm font-medium text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      aria-label={`Switch to ${NEXT_THEME[theme]} theme`}
      title={`Theme: ${theme.charAt(0).toUpperCase() + theme.slice(1)}`}
    >
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: THEME_COLORS[theme] }}
      />
      <span className="hidden sm:inline">
        {theme.charAt(0).toUpperCase() + theme.slice(1)}
      </span>
    </button>
  );
}
