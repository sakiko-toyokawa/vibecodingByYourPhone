import { useEffect, useState } from "react";
import { activityBus } from "../lib/activityBus";
import { type ConnectionState, connectionManager } from "../lib/connection";

interface ActivityBusState {
  connected: boolean;
  /** ConnectionManager state: connected, reconnecting, or disconnected */
  connectionState: ConnectionState;
}

/**
 * Hook to get the current activity bus connection state.
 * Event-driven via ConnectionManager — no polling.
 */
export function useActivityBusState(): ActivityBusState {
  const [state, setState] = useState<ActivityBusState>({
    connected: activityBus.connected,
    connectionState: connectionManager.state,
  });

  useEffect(() => {
    const unsub = connectionManager.on("stateChange", (newState) => {
      setState({
        connected: newState === "connected",
        connectionState: newState,
      });
    });

    return unsub;
  }, []);

  return state;
}
