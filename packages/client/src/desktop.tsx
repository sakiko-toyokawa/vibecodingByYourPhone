import { Fragment, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AppRoutes } from "./AppRoutes";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { initializeFontSize } from "./hooks/useFontSize";
import { initializeTabSize } from "./hooks/useTabSize";
import { initializeTheme } from "./hooks/useTheme";
import "./styles/index.css";

// Apply saved preferences before React renders to avoid flash
initializeTheme();
initializeFontSize();
initializeTabSize();

/**
 * Render the Yep Anywhere client app inside a Tauri desktop window.
 *
 * The desktop app injects `window.__YEP_SERVER_URL__` and `window.__DESKTOP_TOKEN__`
 * before calling this function so the client knows which server to talk to.
 */
export function renderDesktopClient(rootElement: HTMLElement) {
  // Unmount any existing React root (e.g. the desktop shell) before mounting
  if (typeof window !== "undefined" && window.__YEP_ROOT__) {
    window.__YEP_ROOT__.unmount();
    window.__YEP_ROOT__ = undefined;
  }

  const Wrapper = Fragment;
  const root = createRoot(rootElement);
  window.__YEP_ROOT__ = root;

  root.render(
    <Wrapper>
      <ErrorBoundary>
        <BrowserRouter>
          <App>
            <AppRoutes />
          </App>
        </BrowserRouter>
      </ErrorBoundary>
    </Wrapper>,
  );
}
