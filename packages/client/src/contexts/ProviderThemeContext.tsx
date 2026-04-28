import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import type { ProviderName } from "../types";

interface ProviderThemeContextValue {
  activeProvider: ProviderName | null;
}

const ProviderThemeContext = createContext<ProviderThemeContextValue>({
  activeProvider: null,
});

interface ProviderThemeProviderProps {
  activeProvider: ProviderName | null;
  children: ReactNode;
}

/**
 * ProviderThemeProvider — manages the visual theme based on active AI provider.
 *
 * Sets `data-provider` on <html> for CSS variable theming.
 * Sets `provider-anim-{name}` class for provider-specific animations.
 * Removes `data-first-load` after initial mount to enable transitions.
 */
export function ProviderThemeProvider({
  activeProvider,
  children,
}: ProviderThemeProviderProps) {
  const isFirstMount = useRef(true);

  useEffect(() => {
    const html = document.documentElement;

    // Set or remove data-provider attribute
    if (activeProvider) {
      html.setAttribute("data-provider", activeProvider);
    } else {
      html.removeAttribute("data-provider");
    }

    // Update animation class
    const animClasses = [
      "provider-anim-claude",
      "provider-anim-codex",
      "provider-anim-gemini",
      "provider-anim-opencode",
    ];
    for (const cls of animClasses) {
      html.classList.remove(cls);
    }
    if (activeProvider) {
      html.classList.add(`provider-anim-${activeProvider}`);
    }

    // Remove first-load flag after initial mount (enables transitions)
    if (isFirstMount.current) {
      isFirstMount.current = false;
      requestAnimationFrame(() => {
        html.removeAttribute("data-first-load");
      });
    }
  }, [activeProvider]);

  // Set first-load flag on initial render (prevents transition flash)
  useEffect(() => {
    document.documentElement.setAttribute("data-first-load", "true");
  }, []);

  return (
    <ProviderThemeContext.Provider value={{ activeProvider }}>
      {children}
    </ProviderThemeContext.Provider>
  );
}

/**
 * Hook to access the current active provider theme.
 */
export function useProviderTheme(): ProviderThemeContextValue {
  return useContext(ProviderThemeContext);
}
