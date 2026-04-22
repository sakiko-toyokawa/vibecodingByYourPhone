import { useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";
import { activityBus } from "../lib/activityBus";

/**
 * Manages the activityBus connection based on authentication state.
 *
 * When auth is enabled but user is not authenticated, we don't connect
 * to avoid 401 errors that can trigger the browser's basic auth prompt.
 *
 * Visibility handling and stale detection are owned by ConnectionManager.
 */
export function useActivityBusConnection(): void {
  const { isAuthenticated, authEnabled, isLoading } = useAuth();

  useEffect(() => {
    if (isLoading) return;
    const shouldConnect = !authEnabled || isAuthenticated;
    if (shouldConnect) activityBus.connect();
    else activityBus.disconnect();
    return () => activityBus.disconnect();
  }, [isAuthenticated, authEnabled, isLoading]);
}
