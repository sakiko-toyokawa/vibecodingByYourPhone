/**
 * Hook for getting the base path for relay mode URLs.
 *
 * When connected to a relay host, this returns the base path
 * including the username, so links can be constructed correctly.
 *
 * Derives the relay username from RemoteConnectionContext (stable)
 * rather than React Router params (unreliable in nested Routes).
 */

import { useOptionalRemoteConnection } from "../contexts/RemoteConnectionContext";

/**
 * Get the base path for the current relay host.
 *
 * @returns The base path (e.g., "/my-server") or empty string if not in relay mode
 */
export function useRemoteBasePath(): string {
  const conn = useOptionalRemoteConnection();
  const relayUsername = conn?.currentRelayUsername;
  return relayUsername ? `/${relayUsername}` : "";
}

/**
 * Hook to get the current relay username.
 *
 * @returns The relay username or undefined if not in relay mode
 */
export function useRelayUsername(): string | undefined {
  const conn = useOptionalRemoteConnection();
  return conn?.currentRelayUsername ?? undefined;
}
