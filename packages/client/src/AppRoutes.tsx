import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { NavigationLayout } from "./layouts";

const ActivityPage = lazy(() =>
  import("./pages/ActivityPage").then((m) => ({ default: m.ActivityPage })),
);
const AgentsPage = lazy(() =>
  import("./pages/AgentsPage").then((m) => ({ default: m.AgentsPage })),
);
const CodeEditorPage = lazy(() =>
  import("./pages/CodeEditorPage").then((m) => ({ default: m.CodeEditorPage })),
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
const InboxPage = lazy(() =>
  import("./pages/InboxPage").then((m) => ({ default: m.InboxPage })),
);
const LoginPage = lazy(() =>
  import("./pages/LoginPage").then((m) => ({ default: m.LoginPage })),
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

/**
 * Shared application routes used by both browser (main.tsx) and desktop (desktop.tsx) entry points.
 * IMPORTANT: Keep routes in sync with remote-main.tsx — adding a route here? Add it there too!
 */
export function AppRoutes() {
  return (
    <Suspense fallback={<RouteLoading />}>
      <Routes>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        {/* Login page (no layout wrapper) */}
        <Route path="/login" element={<LoginPage />} />
        <Route element={<NavigationLayout />}>
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/sessions" element={<GlobalSessionsPage />} />
          <Route path="/recent" element={<RecentSessionsPage />} />
          <Route path="/older" element={<OlderSessionsPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/loop-center" element={<LoopCenterPage />} />
          <Route
            path="/loops"
            element={<Navigate to="/loop-center?tab=loops" replace />}
          />
          <Route path="/loops/:loopId" element={<LoopDetailPage />} />
          <Route path="/runs/:runId" element={<RunDetailPage />} />
          <Route
            path="/human-queue"
            element={<Navigate to="/loop-center?tab=human" replace />}
          />
          <Route
            path="/maintenance"
            element={<Navigate to="/loop-center?tab=maintenance" replace />}
          />
          <Route
            path="/github"
            element={<Navigate to="/loop-center?tab=pipeline" replace />}
          />
          <Route path="/settings" element={<SettingsLayout />} />
          <Route path="/settings/:category" element={<SettingsLayout />} />
          {/* Project-scoped pages */}
          <Route
            path="/projects/:projectId"
            element={<Navigate to="/sessions" replace />}
          />
          <Route path="/git-status" element={<GitStatusPage />} />
          <Route path="/devices" element={<EmulatorPage />} />
          <Route path="/devices/:deviceId" element={<EmulatorPage />} />
          <Route path="/new-session" element={<NewSessionPage />} />
          <Route
            path="/projects/:projectId/editor"
            element={<CodeEditorPage />}
          />
          <Route
            path="/projects/:projectId/sessions/:sessionId/editor"
            element={<SessionEditorPage />}
          />
          <Route
            path="/projects/:projectId/sessions/:sessionId"
            element={<SessionPage />}
          />
        </Route>
        {/* File page has its own layout (no sidebar) */}
        <Route path="/projects/:projectId/file" element={<FilePage />} />
        {/* Activity page has its own layout */}
        <Route path="/activity" element={<ActivityPage />} />
      </Routes>
    </Suspense>
  );
}
