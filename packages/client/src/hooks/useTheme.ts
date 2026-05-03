import { useCallback, useEffect, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

export type Theme = "claude" | "codex" | "gemini";

const themeLabels: Record<Theme, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
};

export const THEMES: Theme[] = ["claude", "codex", "gemini"];

export function getThemeLabel(theme: Theme): string {
  return themeLabels[theme];
}

function syncSystemBars(theme: Theme) {
  const tauri = (window as unknown as Record<string, unknown>)
    .__TAURI_INTERNALS__ as
    | {
        invoke?: (
          cmd: string,
          args: Record<string, unknown>,
        ) => Promise<unknown>;
      }
    | undefined;
  if (tauri?.invoke) {
    tauri
      .invoke("set_system_bars", { light: theme !== "codex" })
      .catch(() => {});
  }
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  syncSystemBars(theme);
}

function loadTheme(): Theme {
  const stored = localStorage.getItem(UI_KEYS.theme);
  if (stored === "codex") return "codex";
  if (stored === "gemini") return "gemini";
  // Backward compat: old "light" value maps to claude mode
  return "claude";
}

// Module-level subscription so all useTheme instances stay in sync.
// When one component calls setTheme, all others re-render.
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyListeners() {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Hook to manage theme preference.
 * Supports "claude" (light warm), "codex" (dark exchange), and "gemini" (light futuristic) modes.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(loadTheme);

  // Sync with other useTheme instances
  useEffect(() => {
    const unsubscribe = subscribe(() => {
      setThemeState(loadTheme());
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((newTheme: Theme) => {
    localStorage.setItem(UI_KEYS.theme, newTheme);
    setThemeState(newTheme);
    // Notify other useTheme instances so ToolCallRow, DiffLines, etc. re-render
    notifyListeners();
  }, []);

  return { theme, setTheme };
}

/**
 * Initialize theme on app load (call once at startup).
 */
export function initializeTheme() {
  const theme = loadTheme();
  applyTheme(theme);
}

/**
 * Get current resolved theme.
 */
export function getResolvedTheme(): Theme {
  return loadTheme();
}

/**
 * Hook to reactively get the resolved theme.
 */
export function useResolvedTheme(): Theme {
  return useTheme().theme;
}
