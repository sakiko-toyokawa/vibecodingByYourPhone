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

  return <div className={`connection-bar connection-${status}`} />;
}
