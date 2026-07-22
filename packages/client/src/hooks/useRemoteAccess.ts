/**
 * Hook for managing remote access settings.
 *
 * Remote access allows connecting to the yepanywhere server from outside
 * the local network via a relay server. Uses SRP for zero-knowledge
 * password authentication and NaCl for end-to-end encryption.
 */
import { useCallback, useEffect, useState } from "react";
import { fetchJSON } from "../api/client";

export interface RelayConfig {
  /** Relay server URL (e.g., wss://relay.yepanywhere.com/ws) */
  url: string;
  /** Username for relay registration */
  username: string;
}

export type RelayStatus =
  | "disconnected"
  | "connecting"
  | "registering"
  | "waiting"
  | "rejected";

export interface RelayStatusInfo {
  status: RelayStatus;
  error: string | null;
  reconnectAttempts: number;
}

export interface RemoteAccessConfig {
  /** Whether remote access is enabled */
  enabled: boolean;
  /** Username (if enabled) */
  username?: string;
  /** When credentials were created (if enabled) */
  createdAt?: string;
}

export interface RemoteSession {
  sessionId: string;
  username: string;
  createdAt: string;
  lastUsed: string;
  /** Browser profile ID that created this session */
  browserProfileId?: string;
  /** User agent string of device that created this session */
  userAgent?: string;
  /** Origin URL where this session was created from */
  origin?: string;
  /** When the session was last actively connected */
  lastConnectedAt?: string;
}

interface UseRemoteAccessResult {
  /** Current remote access configuration */
  config: RemoteAccessConfig | null;
  /** Current relay configuration */
  relayConfig: RelayConfig | null;
  /** Current relay connection status */
  relayStatus: RelayStatusInfo | null;
  /** Active remote sessions */
  sessions: RemoteSession[];
  /** Whether the config is loading */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** Configure remote access with password (relay must be configured first) */
  configure: (password: string) => Promise<void>;
  /** Enable remote access (must be configured first) */
  enable: () => Promise<void>;
  /** Disable remote access */
  disable: () => Promise<void>;
  /** Clear credentials without disabling */
  clearCredentials: () => Promise<void>;
  /** Update relay configuration */
  updateRelayConfig: (config: RelayConfig) => Promise<void>;
  /** Clear relay configuration */
  clearRelayConfig: () => Promise<void>;
  /** Revoke a specific session */
  revokeSession: (sessionId: string) => Promise<void>;
  /** Revoke all sessions */
  revokeAllSessions: () => Promise<void>;
  /** Refresh the configuration */
  refresh: () => Promise<void>;
}

export function useRemoteAccess(): UseRemoteAccessResult {
  const [config, setConfig] = useState<RemoteAccessConfig | null>(null);
  const [relayConfig, setRelayConfig] = useState<RelayConfig | null>(null);
  const [relayStatus, setRelayStatus] = useState<RelayStatusInfo | null>(null);
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [configResponse, relayResponse, statusResponse, sessionsResponse] =
        await Promise.all([
          fetchJSON<RemoteAccessConfig>("/remote-access/config"),
          fetchJSON<{ relay: RelayConfig | null }>("/remote-access/relay"),
          fetchJSON<RelayStatusInfo>("/remote-access/relay/status"),
          fetchJSON<{ sessions: RemoteSession[] }>("/remote-access/sessions"),
        ]);
      setConfig(configResponse);
      setRelayConfig(relayResponse.relay);
      setRelayStatus(statusResponse);
      setSessions(sessionsResponse.sessions);
      setError(null);
    } catch (err) {
      console.error("[useRemoteAccess] Failed to fetch config:", err);
      setError(err instanceof Error ? err.message : "Failed to fetch config");
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const configure = useCallback(
    async (password: string) => {
      try {
        await fetchJSON("/remote-access/configure", {
          method: "POST",
          body: JSON.stringify({ password }),
        });
        await refresh();
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to configure remote access";
        setError(message);
        throw new Error(message);
      }
    },
    [refresh],
  );

  const enable = useCallback(async () => {
    try {
      await fetchJSON("/remote-access/enable", {
        method: "POST",
      });
      await refresh();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to enable remote access";
      setError(message);
      throw new Error(message);
    }
  }, [refresh]);

  const disable = useCallback(async () => {
    try {
      await fetchJSON("/remote-access/disable", {
        method: "POST",
      });
      await refresh();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to disable remote access";
      setError(message);
      throw new Error(message);
    }
  }, [refresh]);

  const clearCredentials = useCallback(async () => {
    try {
      await fetchJSON("/remote-access/clear", {
        method: "POST",
      });
      await refresh();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to clear remote access credentials";
      setError(message);
      throw new Error(message);
    }
  }, [refresh]);

  const updateRelayConfig = useCallback(
    async (newConfig: RelayConfig) => {
      try {
        await fetchJSON("/remote-access/relay", {
          method: "PUT",
          body: JSON.stringify(newConfig),
        });
        await refresh();
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to update relay configuration";
        setError(message);
        throw new Error(message);
      }
    },
    [refresh],
  );

  const clearRelayConfig = useCallback(async () => {
    try {
      await fetchJSON("/remote-access/relay", {
        method: "DELETE",
      });
      await refresh();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to clear relay configuration";
      setError(message);
      throw new Error(message);
    }
  }, [refresh]);

  const revokeSession = useCallback(
    async (sessionId: string) => {
      try {
        await fetchJSON(`/remote-access/sessions/${sessionId}`, {
          method: "DELETE",
        });
        await refresh();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to revoke session";
        setError(message);
        throw new Error(message);
      }
    },
    [refresh],
  );

  const revokeAllSessions = useCallback(async () => {
    try {
      await fetchJSON("/remote-access/sessions", {
        method: "DELETE",
      });
      await refresh();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to revoke all sessions";
      setError(message);
      throw new Error(message);
    }
  }, [refresh]);

  return {
    config,
    relayConfig,
    relayStatus,
    sessions,
    loading,
    error,
    configure,
    enable,
    disable,
    clearCredentials,
    updateRelayConfig,
    clearRelayConfig,
    revokeSession,
    revokeAllSessions,
    refresh,
  };
}
