import {
  type Connection,
  directConnection,
  getGlobalConnection,
} from "../lib/connection";

/**
 * Hook that provides the current connection to the server.
 *
 * Priority order:
 * 1. Global connection (SecureConnection in remote mode)
 * 2. DirectConnection (default — REST + upload via HTTP)
 *
 * Note: Subscriptions (session/activity streams) are handled separately
 * by useSSE and ActivityBus, which always use WebSocket.
 *
 * @returns The active Connection instance
 */
export function useConnection(): Connection {
  // Check for global connection first (remote mode with SecureConnection)
  const globalConn = getGlobalConnection();
  if (globalConn) {
    return globalConn;
  }

  // Default: use direct connection (fetch + upload via HTTP)
  return directConnection;
}
