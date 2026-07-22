/**
 * ConnectionBar - A thin colored bar at the top of the screen
 * showing transport connection status.
 *
 * Uses ConnectionManager as the single source of truth:
 * - Green: connected
 * - Orange (pulsing): reconnecting
 * - Red: disconnected
 */

import { useLocation } from "react-router-dom";
import { useActivityBusState } from "../hooks/useActivityBusState";
import { useDeveloperMode } from "../hooks/useDeveloperMode";

/** Routes where we don't show the connection bar */
const LOGIN_ROUTES = ["/login", "/login/direct", "/login/relay"];

export function ConnectionBar() {
  const location = useLocation();
  const { connectionState } = useActivityBusState();
  const { showConnectionBars } = useDeveloperMode();

  // Don't show on login routes or if disabled in settings
  const isLoginRoute = LOGIN_ROUTES.some(
    (route) =>
      location.pathname === route || location.pathname.startsWith(`${route}/`),
  );
  if (isLoginRoute || !showConnectionBars) {
    return null;
  }

  // Map ConnectionManager state to CSS class
  const status =
    connectionState === "reconnecting" ? "connecting" : connectionState;

  const statusClasses = {
    connected: "bg-[var(--success-color)]",
    connecting:
      "bg-[var(--thinking-color)] animate-[connection-pulse_1.5s_ease-in-out_infinite]",
    disconnected: "bg-[var(--error-color)]",
  };

  return (
    <div
      className={`fixed top-[env(safe-area-inset-top,0px)] left-0 right-0 h-0.5 z-[9999] pointer-events-none transition-colors duration-300 ${statusClasses[status as keyof typeof statusClasses] || ""}`}
    />
  );
}
