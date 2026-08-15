/**
 * Remote client entry point.
 *
 * This is a separate entry point for the remote (static) client that:
 * - Uses SecureConnection for all communication (SRP + NaCl encryption)
 * - Shows a login page before connecting
 * - Does NOT use cookie-based auth (uses SRP instead)
 *
 * Route structure:
 * - UnauthenticatedGate: wraps login routes, redirects to app if already connected
 * - ConnectionGate: wraps direct-mode app routes (no relay username in URL)
 * - RelayConnectionGate: wraps relay-mode app routes (/:relayUsername/...)
 *
 * ConnectionGate and RelayConnectionGate share the same APP_ROUTES.
 * This avoids duplicating route definitions or provider wrapping.
 */

console.log("[RemoteClient] Loading remote-main.tsx entry point");

import { Fragment, StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";

// Toggle to disable StrictMode for easier debugging (avoids double renders)
const STRICT_MODE = false;
const Wrapper = STRICT_MODE ? StrictMode : Fragment;

import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ConnectionGate, RemoteApp, UnauthenticatedGate } from "./RemoteApp";
import { initializeFontSize } from "./hooks/useFontSize";
import { initializeTabSize } from "./hooks/useTabSize";
import { initializeTheme } from "./hooks/useTheme";
import { I18nProvider } from "./i18n";
import { NavigationLayout } from "./layouts";
import "./styles/index.css";

const ActivityPage = lazy(() =>
  import("./pages/ActivityPage").then((m) => ({ default: m.ActivityPage })),
);
const AgentsPage = lazy(() =>
  import("./pages/AgentsPage").then((m) => ({ default: m.AgentsPage })),
);
const CodeEditorPage = lazy(() =>
  import("./pages/CodeEditorPage").then((m) => ({ default: m.CodeEditorPage })),
);
const DirectLoginPage = lazy(() =>
  import("./pages/DirectLoginPage").then((m) => ({
    default: m.DirectLoginPage,
  })),
);
const EmulatorPage = lazy(() =>
  import("./pages/EmulatorPage").then((m) => ({ default: m.EmulatorPage })),
);
const FilePage = lazy(() =>
  import("./pages/FilePage").then((m) => ({ default: m.FilePage })),
);
const GitStatusPage = lazy(() =>
  import("./pages/GitStatusPage").then((m) => ({ default: m.GitStatusPage })),
);
const GlobalSessionsPage = lazy(() =>
  import("./pages/GlobalSessionsPage").then((m) => ({
    default: m.GlobalSessionsPage,
  })),
);
const HostPickerPage = lazy(() =>
  import("./pages/HostPickerPage").then((m) => ({
    default: m.HostPickerPage,
  })),
);
const InboxPage = lazy(() =>
  import("./pages/InboxPage").then((m) => ({ default: m.InboxPage })),
);
const LoopCenterPage = lazy(() =>
  import("./pages/LoopCenterPage").then((m) => ({ default: m.LoopCenterPage })),
);
const LoopDetailPage = lazy(() =>
  import("./pages/LoopDetailPage").then((m) => ({ default: m.LoopDetailPage })),
);
const NewSessionPage = lazy(() =>
  import("./pages/NewSessionPage").then((m) => ({ default: m.NewSessionPage })),
);
const OlderSessionsPage = lazy(() =>
  import("./pages/OlderSessionsPage").then((m) => ({
    default: m.OlderSessionsPage,
  })),
);
const ProjectsPage = lazy(() =>
  import("./pages/ProjectsPage").then((m) => ({ default: m.ProjectsPage })),
);
const RecentSessionsPage = lazy(() =>
  import("./pages/RecentSessionsPage").then((m) => ({
    default: m.RecentSessionsPage,
  })),
);
const RelayConnectionGate = lazy(() =>
  import("./pages/RelayConnectionGate").then((m) => ({
    default: m.RelayConnectionGate,
  })),
);
const RelayLoginPage = lazy(() =>
  import("./pages/RelayLoginPage").then((m) => ({
    default: m.RelayLoginPage,
  })),
);
const RunDetailPage = lazy(() =>
  import("./pages/RunDetailPage").then((m) => ({ default: m.RunDetailPage })),
);
const SessionEditorPage = lazy(() =>
  import("./pages/SessionEditorPage").then((m) => ({
    default: m.SessionEditorPage,
  })),
);
const SessionPage = lazy(() =>
  import("./pages/SessionPage").then((m) => ({ default: m.SessionPage })),
);
const SettingsLayout = lazy(() =>
  import("./pages/settings").then((m) => ({ default: m.SettingsLayout })),
);

function RouteLoading() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center p-6 text-sm text-[var(--text-muted)]">
      Loading…
    </div>
  );
}

// Apply saved preferences before React renders to avoid flash
initializeTheme();
initializeFontSize();
initializeTabSize();

// Get base URL for router (Vite sets this based on --base flag)
// Remove trailing slash for BrowserRouter basename
const basename = import.meta.env.BASE_URL.replace(/\/$/, "") || undefined;

const rootPath = (basename ? `${basename}/projects` : "/projects").replace(
  /\/+/g,
  "/",
);

(window as unknown as Record<string, unknown>).__TAURI_BACK_PRESSED__ = () => {
  const current = window.location.pathname.replace(/\/$/, "") || "/";
  if (current === rootPath || current === (basename || "/")) {
    if (confirm("Exit app?")) {
      (
        window as unknown as {
          __TAURI_INTERNALS__?: { invoke: (cmd: string) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__?.invoke("exit_app");
    }
  } else {
    window.history.back();
  }
};

/**
 * Shared app routes used by both direct mode (ConnectionGate) and
 * relay mode (RelayConnectionGate). Uses relative paths so they resolve
 * correctly under both "/" and "/:relayUsername/".
 */
const APP_ROUTES = (
  <>
    <Route index element={<Navigate to="projects" replace />} />

    {/* IMPORTANT: Keep routes in sync with main.tsx — adding a route here? Add it there too! */}
    <Route element={<NavigationLayout />}>
      <Route path="projects" element={<ProjectsPage />} />
      <Route path="sessions" element={<GlobalSessionsPage />} />
      <Route path="recent" element={<RecentSessionsPage />} />
      <Route path="older" element={<OlderSessionsPage />} />
      <Route path="agents" element={<AgentsPage />} />
      <Route path="inbox" element={<InboxPage />} />
      <Route path="loop-center" element={<LoopCenterPage />} />
      <Route
        path="loops"
        element={<Navigate to="../loop-center?tab=loops" replace />}
      />
      <Route path="loops/:loopId" element={<LoopDetailPage />} />
      <Route path="runs/:runId" element={<RunDetailPage />} />
      <Route
        path="human-queue"
        element={<Navigate to="../loop-center?tab=human" replace />}
      />
      <Route
        path="maintenance"
        element={<Navigate to="../loop-center?tab=maintenance" replace />}
      />
      <Route
        path="github"
        element={<Navigate to="../loop-center?tab=pipeline" replace />}
      />
      <Route path="git-status" element={<GitStatusPage />} />
      <Route path="devices" element={<EmulatorPage />} />
      <Route path="devices/:deviceId" element={<EmulatorPage />} />
      <Route path="settings" element={<SettingsLayout />} />
      <Route path="settings/:category" element={<SettingsLayout />} />
      <Route path="new-session" element={<NewSessionPage />} />
      <Route path="projects/:projectId/editor" element={<CodeEditorPage />} />
      <Route
        path="projects/:projectId/sessions/:sessionId/editor"
        element={<SessionEditorPage />}
      />
      <Route
        path="projects/:projectId/sessions/:sessionId"
        element={<SessionPage />}
      />
    </Route>

    {/* Pages with custom layouts */}
    <Route path="projects/:projectId/file" element={<FilePage />} />
    <Route path="activity" element={<ActivityPage />} />

    {/* Catch-all redirect to projects (must use ../ to escape splat route's relative resolution) */}
    <Route path="*" element={<Navigate to="../projects" replace />} />
  </>
);

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <Wrapper>
    <BrowserRouter basename={basename}>
      <I18nProvider>
        <RemoteApp>
          <Suspense fallback={<RouteLoading />}>
            <Routes>
              {/* Login routes — redirect to app if already connected */}
              <Route element={<UnauthenticatedGate />}>
                <Route path="/login" element={<HostPickerPage />} />
                <Route path="/login/direct" element={<DirectLoginPage />} />
                <Route path="/login/relay" element={<RelayLoginPage />} />
              </Route>

              {/* Direct mode — requires connection, no relay username in URL */}
              <Route element={<ConnectionGate />}>{APP_ROUTES}</Route>

              {/* Relay mode — manages relay connection by URL username.
                  React Router ranks static segments above dynamic params,
                  so /projects matches ConnectionGate, not /:relayUsername. */}
              <Route path="/:relayUsername" element={<RelayConnectionGate />}>
                {APP_ROUTES}
              </Route>
            </Routes>
          </Suspense>
        </RemoteApp>
      </I18nProvider>
    </BrowserRouter>
  </Wrapper>,
);
