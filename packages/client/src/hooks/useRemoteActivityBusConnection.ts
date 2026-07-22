import { useEffect } from "react";
import { activityBus } from "../lib/activityBus";

/**
 * Manages the activityBus connection for remote mode.
 *
 * Doesn't check auth state because remote mode is already authenticated
 * via SRP when this hook runs (the connection gate ensures this).
 *
 * Visibility handling and stale detection are owned by ConnectionManager.
 */
export function useRemoteActivityBusConnection(): void {
  useEffect(() => {
    activityBus.connect();
    return () => activityBus.disconnect();
  }, []);
}
