import {
  getRemoteLogCollectionEnabled,
  subscribeDeveloperMode,
} from "../../hooks/useDeveloperMode";
import { ClientLogCollector } from "./ClientLogCollector";

export const clientLogCollector = new ClientLogCollector();

/**
 * Initialize client log collection based on the developer mode setting.
 * Starts/stops the collector when the setting changes.
 * Returns a cleanup function.
 */
export function initClientLogCollection(): () => void {
  function sync() {
    if (getRemoteLogCollectionEnabled()) {
      clientLogCollector.start();
    } else {
      clientLogCollector.stop();
    }
  }

  // Initial sync
  sync();

  // React to setting changes
  const unsubscribe = subscribeDeveloperMode(sync);

  return () => {
    unsubscribe();
    clientLogCollector.stop();
  };
}
