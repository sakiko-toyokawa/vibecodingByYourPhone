import { Navigate, Route, Routes } from "react-router-dom";
import { NavigationLayout } from "./layouts";
import { ActivityPage } from "./pages/ActivityPage";
import { AgentsPage } from "./pages/AgentsPage";
import { EmulatorPage } from "./pages/EmulatorPage";
import { FilePage } from "./pages/FilePage";
import { GitStatusPage } from "./pages/GitStatusPage";
import { GlobalSessionsPage } from "./pages/GlobalSessionsPage";
import { InboxPage } from "./pages/InboxPage";
import { LoginPage } from "./pages/LoginPage";
import { NewSessionPage } from "./pages/NewSessionPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SessionPage } from "./pages/SessionPage";
import { SettingsLayout } from "./pages/settings";

/**
 * Shared application routes used by both browser (main.tsx) and desktop (desktop.tsx) entry points.
 * IMPORTANT: Keep routes in sync with remote-main.tsx — adding a route here? Add it there too!
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/projects" replace />} />
      {/* Login page (no layout wrapper) */}
      <Route path="/login" element={<LoginPage />} />
      <Route element={<NavigationLayout />}>
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/sessions" element={<GlobalSessionsPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/inbox" element={<InboxPage />} />
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
          path="/projects/:projectId/sessions/:sessionId"
          element={<SessionPage />}
        />
      </Route>
      {/* File page has its own layout (no sidebar) */}
      <Route path="/projects/:projectId/file" element={<FilePage />} />
      {/* Activity page has its own layout */}
      <Route path="/activity" element={<ActivityPage />} />
    </Routes>
  );
}
