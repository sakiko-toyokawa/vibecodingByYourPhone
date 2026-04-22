/**
 * HostPickerPage - Saved hosts list and login mode selection.
 *
 * Shows:
 * - List of saved hosts with status indicators and quick connect
 * - "Add Host" section with relay/login/direct options
 */

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { YepAnywhereLogo } from "../components/YepAnywhereLogo";
import { useRemoteConnection } from "../contexts/RemoteConnectionContext";
import { useI18n } from "../i18n";
import { type SavedHost, loadSavedHosts, removeHost } from "../lib/hostStorage";

type HostStatus = "online" | "offline" | "checking" | "unknown";

interface HostStatusMap {
  [hostId: string]: HostStatus;
}

export function HostPickerPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { isAutoResuming, connectViaRelay, connect, setCurrentHostId } =
    useRemoteConnection();
  const [hosts, setHosts] = useState<SavedHost[]>([]);
  const [hostStatuses, setHostStatuses] = useState<HostStatusMap>({});
  const [connectingHostId, setConnectingHostId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load hosts on mount
  useEffect(() => {
    const data = loadSavedHosts();
    setHosts(data.hosts);
  }, []);

  // Check status for relay hosts
  useEffect(() => {
    const relayHosts = hosts.filter((h) => h.mode === "relay");
    if (relayHosts.length === 0) return;

    // Mark all as checking
    setHostStatuses((prev) => {
      const next = { ...prev };
      for (const host of relayHosts) {
        if (!next[host.id]) {
          next[host.id] = "checking";
        }
      }
      return next;
    });

    // Check each relay host status
    for (const host of relayHosts) {
      checkRelayHostStatus(host).then((status) => {
        setHostStatuses((prev) => ({ ...prev, [host.id]: status }));
      });
    }
  }, [hosts]);

  // Check if a relay host's server is online via the relay's HTTP API
  const checkRelayHostStatus = useCallback(
    async (host: SavedHost): Promise<HostStatus> => {
      if (!host.relayUrl || !host.relayUsername) return "unknown";

      try {
        // Convert ws:// or wss:// URL to http:// or https:// and remove /ws suffix
        const httpUrl = host.relayUrl
          .replace(/^ws/, "http")
          .replace(/\/ws$/, "");
        const res = await fetch(
          `${httpUrl}/online/${encodeURIComponent(host.relayUsername)}`,
          { signal: AbortSignal.timeout(5000) },
        );
        if (!res.ok) return "offline";
        const data = await res.json();
        return data.online ? "online" : "offline";
      } catch {
        return "offline";
      }
    },
    [],
  );

  // Connect to a saved host
  const handleConnectHost = useCallback(
    async (host: SavedHost) => {
      setConnectingHostId(host.id);
      setError(null);

      try {
        if (host.mode === "relay") {
          if (!host.relayUrl || !host.relayUsername) {
            throw new Error(t("hostPickerMissingRelayConfiguration"));
          }

          // If host has a session, try to use it for auto-resume
          // Otherwise, navigate to relay login pre-filled
          if (host.session) {
            // Set current host ID before connecting so ConnectionGate knows where to redirect
            setCurrentHostId(host.id);
            await connectViaRelay({
              relayUrl: host.relayUrl,
              relayUsername: host.relayUsername,
              srpUsername: host.srpUsername,
              srpPassword: "", // Ignored when session is provided
              rememberMe: true,
              onStatusChange: () => {},
              session: host.session,
            });
            // ConnectionGate will redirect to /{username}/projects (URL: /remote/{username}/projects)
          } else {
            // No session - go to relay login pre-filled
            navigate(
              `/login/relay?u=${encodeURIComponent(host.relayUsername)}`,
            );
          }
        } else {
          // Direct mode
          if (!host.wsUrl) {
            throw new Error(t("hostPickerMissingWebSocketUrl"));
          }

          if (host.session) {
            await connect(host.wsUrl, host.srpUsername, "", true);
            // Success - navigate to projects (direct mode doesn't use username URLs)
            navigate("/projects");
          } else {
            // No session - go to direct login pre-filled
            navigate("/login/direct");
          }
        }
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : t("hostPickerErrorConnectionFailed");
        // If session resumption failed, redirect to login page
        if (
          message.includes("Authentication failed") ||
          message.includes("invalid")
        ) {
          if (host.mode === "relay" && host.relayUsername) {
            navigate(
              `/login/relay?u=${encodeURIComponent(host.relayUsername)}`,
            );
          } else {
            navigate("/login/direct");
          }
        } else {
          setError(message);
        }
      } finally {
        setConnectingHostId(null);
      }
    },
    [connectViaRelay, connect, navigate, setCurrentHostId, t],
  );

  // Delete a host
  const handleDeleteHost = useCallback(
    (hostId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      if (confirm(t("hostPickerRemoveConfirm"))) {
        removeHost(hostId);
        setHosts((prev) => prev.filter((h) => h.id !== hostId));
      }
    },
    [t],
  );

  // Format last connected time
  const formatLastConnected = (isoString?: string): string => {
    if (!isoString) return "";
    try {
      const date = new Date(isoString);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return t("hostPickerLastConnectedJustNow");
      if (diffMins < 60)
        return t("hostPickerLastConnectedMinutes", { count: diffMins });
      if (diffHours < 24)
        return t("hostPickerLastConnectedHours", { count: diffHours });
      if (diffDays < 7)
        return t("hostPickerLastConnectedDays", { count: diffDays });
      return date.toLocaleDateString();
    } catch {
      return "";
    }
  };

  // If auto-resume is in progress, show a loading screen
  if (isAutoResuming) {
    return (
      <div className="login-page">
        <div className="login-container">
          <div className="login-logo">
            <YepAnywhereLogo />
          </div>
          <p className="login-subtitle">{t("reconnecting")}</p>
          <div className="login-loading" data-testid="auto-resume-loading">
            <div className="login-spinner" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-container">
        <div className="login-logo">
          <YepAnywhereLogo />
        </div>

        {hosts.length > 0 && (
          <>
            <p className="login-subtitle">{t("hostPickerSavedHosts")}</p>

            <div className="host-picker-list" data-testid="saved-hosts-list">
              {hosts.map((host) => {
                const status = hostStatuses[host.id] ?? "unknown";
                const isConnecting = connectingHostId === host.id;

                return (
                  <button
                    key={host.id}
                    type="button"
                    className="host-picker-item"
                    onClick={() => handleConnectHost(host)}
                    disabled={isConnecting}
                    data-testid={`host-item-${host.id}`}
                  >
                    <div className="host-picker-item-main">
                      <span
                        className={`host-picker-status host-picker-status-${status}`}
                        title={t(
                          `hostPickerStatus${status.charAt(0).toUpperCase()}${status.slice(1)}` as never,
                        )}
                      />
                      <span className="host-picker-name">
                        {host.displayName}
                      </span>
                      <span className="host-picker-mode">{host.mode}</span>
                    </div>
                    <div className="host-picker-item-meta">
                      {host.lastConnected && (
                        <span className="host-picker-last-connected">
                          {formatLastConnected(host.lastConnected)}
                        </span>
                      )}
                      <button
                        type="button"
                        className="host-picker-delete"
                        onClick={(e) => handleDeleteHost(host.id, e)}
                        title={t("hostPickerRemoveHost")}
                        data-testid={`delete-host-${host.id}`}
                      >
                        &times;
                      </button>
                    </div>
                    {isConnecting && (
                      <div className="host-picker-connecting">
                        <div className="login-spinner" />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {error && (
              <div className="login-error" data-testid="host-picker-error">
                {error}
              </div>
            )}

            <p className="login-subtitle host-picker-add-title">
              {t("hostPickerAddNewHost")}
            </p>
          </>
        )}

        {hosts.length === 0 && (
          <p className="login-subtitle">{t("hostPickerHowToConnect")}</p>
        )}

        <div className="login-mode-options">
          <button
            type="button"
            className="login-mode-option"
            onClick={() => navigate("/login/relay")}
            data-testid="relay-mode-button"
          >
            <span className="login-mode-option-title">
              {t("hostPickerRelayTitle")}
            </span>
            <span className="login-mode-option-desc">
              {t("hostPickerRelayDescription")}
            </span>
          </button>

          <button
            type="button"
            className="login-mode-option login-mode-option-secondary"
            onClick={() => navigate("/login/direct")}
            data-testid="direct-mode-button"
          >
            <span className="login-mode-option-title">
              {t("hostPickerDirectTitle")}
            </span>
            <span className="login-mode-option-desc">
              {t("hostPickerDirectDescription")}
            </span>
          </button>
        </div>

        <p className="login-hint">
          {hosts.length > 0
            ? t("hostPickerSavedHint")
            : t("hostPickerEmptyHint")}
        </p>
      </div>
    </div>
  );
}
