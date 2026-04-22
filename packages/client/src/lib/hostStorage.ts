/**
 * Multi-host storage for remote access.
 *
 * Stores multiple saved hosts (relay or direct) with their SRP sessions
 * for quick reconnection without re-entering credentials.
 */

import type { StoredSession } from "./connection/SecureConnection";
import { SAVED_HOSTS_KEY } from "./storageKeys";
import { generateUUID } from "./uuid";

/** A saved host configuration */
export interface SavedHost {
  id: string;
  displayName: string;
  mode: "relay" | "direct";

  // Relay mode fields
  relayUrl?: string;
  relayUsername?: string;

  // Direct mode fields
  wsUrl?: string;

  // Auth
  srpUsername: string;
  session?: StoredSession;

  // Metadata
  lastConnected?: string;
  createdAt: string;
}

/** Root storage structure */
export interface SavedHostsStorage {
  version: 1;
  hosts: SavedHost[];
}

/** Load saved hosts from localStorage */
export function loadSavedHosts(): SavedHostsStorage {
  try {
    const stored = localStorage.getItem(SAVED_HOSTS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as SavedHostsStorage;
      if (parsed.version === 1 && Array.isArray(parsed.hosts)) {
        return parsed;
      }
    }
  } catch {
    // Ignore parse errors
  }
  return { version: 1, hosts: [] };
}

/** Save the entire hosts storage */
function saveSavedHosts(data: SavedHostsStorage): void {
  try {
    localStorage.setItem(SAVED_HOSTS_KEY, JSON.stringify(data));
  } catch {
    // Ignore storage errors
  }
}

/** Add or update a host */
export function saveHost(host: SavedHost): void {
  const data = loadSavedHosts();
  const existingIndex = data.hosts.findIndex((h) => h.id === host.id);

  if (existingIndex >= 0) {
    data.hosts[existingIndex] = host;
  } else {
    data.hosts.push(host);
  }

  saveSavedHosts(data);
}

/** Create or update a relay host and optionally attach its stored session. */
export function upsertRelayHost(params: {
  relayUrl: string;
  relayUsername: string;
  srpUsername: string;
  session?: StoredSession;
}): SavedHost {
  const existing = getHostByRelayUsername(params.relayUsername);
  const host: SavedHost = existing
    ? {
        ...existing,
        relayUrl: params.relayUrl,
        srpUsername: params.srpUsername,
        session: params.session ?? existing.session,
        lastConnected: params.session
          ? new Date().toISOString()
          : existing.lastConnected,
      }
    : {
        ...createRelayHost(params),
        session: params.session,
        lastConnected: params.session ? new Date().toISOString() : undefined,
      };

  saveHost(host);
  return host;
}

/** Update just the session for a host (for session resumption) */
export function updateHostSession(
  id: string,
  session: StoredSession | undefined,
): void {
  const data = loadSavedHosts();
  const host = data.hosts.find((h) => h.id === id);

  if (host) {
    host.session = session;
    host.lastConnected = new Date().toISOString();
    saveSavedHosts(data);
  }
}

/** Remove a host by ID */
export function removeHost(id: string): void {
  const data = loadSavedHosts();
  data.hosts = data.hosts.filter((h) => h.id !== id);
  saveSavedHosts(data);
}

/** Find a host by relay username */
export function getHostByRelayUsername(
  username: string,
): SavedHost | undefined {
  const data = loadSavedHosts();
  return data.hosts.find(
    (h) => h.mode === "relay" && h.relayUsername === username,
  );
}

/** Find a host by ID */
export function getHostById(id: string): SavedHost | undefined {
  const data = loadSavedHosts();
  return data.hosts.find((h) => h.id === id);
}

/** Create a new relay host (doesn't save yet - call saveHost to persist) */
export function createRelayHost(params: {
  relayUrl: string;
  relayUsername: string;
  srpUsername: string;
  displayName?: string;
}): SavedHost {
  return {
    id: generateUUID(),
    displayName: params.displayName ?? params.relayUsername,
    mode: "relay",
    relayUrl: params.relayUrl,
    relayUsername: params.relayUsername,
    srpUsername: params.srpUsername,
    createdAt: new Date().toISOString(),
  };
}

/** Create a new direct host (doesn't save yet - call saveHost to persist) */
export function createDirectHost(params: {
  wsUrl: string;
  srpUsername: string;
  displayName?: string;
}): SavedHost {
  // Generate a display name from URL if not provided
  let defaultName = params.srpUsername;
  try {
    const url = new URL(params.wsUrl);
    defaultName = url.hostname;
  } catch {
    // Keep srpUsername as default
  }

  return {
    id: generateUUID(),
    displayName: params.displayName ?? defaultName,
    mode: "direct",
    wsUrl: params.wsUrl,
    srpUsername: params.srpUsername,
    createdAt: new Date().toISOString(),
  };
}
