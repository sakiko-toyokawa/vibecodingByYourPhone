/**
 * RemoteAccessSetup - Single-screen component for configuring remote access.
 *
 * Reusable in both Settings and Onboarding flows.
 */

import { useEffect, useState } from "react";
import { type RelayStatus, useRemoteAccess } from "../hooks/useRemoteAccess";
import { useI18n } from "../i18n";
import { parseUserAgent } from "../lib/deviceDetection";
import { QRCode } from "./QRCode";

const DEFAULT_RELAY_URL = "wss://relay.yepanywhere.com/ws";
const CONNECT_URL = "https://yepanywhere.com/remote/login/relay";

export interface RemoteAccessSetupProps {
  /** Custom title (default: "Remote Access") */
  title?: string;
  /** Custom description */
  description?: string;
  /** Callback when setup completes successfully */
  onSetupComplete?: () => void;
}

/**
 * Format a date for display with relative time.
 */
function formatRelativeDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString();
}

function formatRelativeDateWithT(
  isoDate: string,
  t: (key: never, vars?: Record<string, string | number>) => string,
): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMinutes < 1) {
    return t("remoteSetupJustNow" as never);
  }
  if (diffMinutes < 60) {
    return t("remoteSetupMinutesAgo" as never, {
      count: diffMinutes,
      suffix: diffMinutes === 1 ? "" : "s",
    });
  }
  if (diffHours < 24) {
    return t("remoteSetupHoursAgo" as never, {
      count: diffHours,
      suffix: diffHours === 1 ? "" : "s",
    });
  }
  if (diffDays === 1) {
    return t("remoteSetupYesterday" as never);
  }
  if (diffDays < 7) {
    return t("hostPickerLastConnectedDays" as never, { count: diffDays });
  }
  return formatRelativeDate(isoDate);
}

/**
 * Get human-readable status text and color class.
 */
function getStatusDisplay(
  status: RelayStatus | null,
  enabled: boolean,
  hasCredentials: boolean,
  t: (key: never) => string,
): { text: string; className: string } {
  if (!enabled) {
    return {
      text: t("remoteSetupStatusDisabled" as never),
      className: "status-disabled",
    };
  }
  if (!hasCredentials) {
    return {
      text: t("remoteSetupStatusNotConfigured" as never),
      className: "status-warning",
    };
  }
  switch (status) {
    case "waiting":
      return {
        text: t("remoteSetupStatusConnected" as never),
        className: "status-success",
      };
    case "connecting":
      return {
        text: t("remoteSetupStatusConnecting" as never),
        className: "status-pending",
      };
    case "registering":
      return {
        text: t("remoteSetupStatusRegistering" as never),
        className: "status-pending",
      };
    case "rejected":
      return {
        text: t("remoteSetupStatusUsernameTaken" as never),
        className: "status-error",
      };
    default:
      return {
        text: t("remoteSetupStatusDisconnected" as never),
        className: "status-warning",
      };
  }
}

type RelayOption = "default" | "custom";

export function RemoteAccessSetup({
  title = "Remote Access",
  description = "Access your server from anywhere.",
  onSetupComplete,
}: RemoteAccessSetupProps) {
  const { t } = useI18n();
  const {
    config,
    relayConfig,
    relayStatus,
    sessions,
    loading,
    error: hookError,
    configure,
    enable,
    disable,
    updateRelayConfig,
    revokeSession,
    revokeAllSessions,
    refresh,
  } = useRemoteAccess();

  // Form state
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [relayOption, setRelayOption] = useState<RelayOption>("default");
  const [customRelayUrl, setCustomRelayUrl] = useState("");

  // UI state
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  // Password for QR code generation (kept in memory after successful save)
  const [savedPassword, setSavedPassword] = useState<string | null>(null);
  const [showQRCode, setShowQRCode] = useState(false);

  // Initialize form from existing config
  useEffect(() => {
    if (relayConfig) {
      setUsername(relayConfig.username);
      if (relayConfig.url === DEFAULT_RELAY_URL) {
        setRelayOption("default");
        setCustomRelayUrl("");
      } else {
        setRelayOption("custom");
        setCustomRelayUrl(relayConfig.url);
      }
    }
  }, [relayConfig]);

  // Track changes
  useEffect(() => {
    const usernameChanged = username !== (relayConfig?.username ?? "");
    const passwordChanged = password.length > 0;

    const currentRelayUrl =
      relayOption === "default" ? DEFAULT_RELAY_URL : customRelayUrl;
    const savedRelayUrl = relayConfig?.url ?? DEFAULT_RELAY_URL;
    const relayUrlChanged = currentRelayUrl !== savedRelayUrl;

    setHasChanges(usernameChanged || passwordChanged || relayUrlChanged);
  }, [username, password, relayOption, customRelayUrl, relayConfig]);

  // Poll for status updates when connecting
  useEffect(() => {
    if (
      relayStatus?.status === "connecting" ||
      relayStatus?.status === "registering"
    ) {
      const interval = setInterval(refresh, 2000);
      return () => clearInterval(interval);
    }
  }, [relayStatus?.status, refresh]);

  const isEnabled = config?.enabled ?? false;
  const hasCredentials = !!config?.username;

  // Get the relay URL based on current selection
  const getRelayUrl = () =>
    relayOption === "default" ? DEFAULT_RELAY_URL : customRelayUrl;

  // Save changes (relay config + password)
  const saveChanges = async () => {
    setError(null);

    // Validation
    if (!username.trim()) {
      setError(t("remoteSetupErrorUsernameRequired" as never));
      return false;
    }
    if (username.length < 3) {
      setError(t("remoteSetupErrorUsernameShort" as never));
      return false;
    }
    if (!hasCredentials && !password) {
      setError(t("remoteSetupErrorPasswordRequired" as never));
      return false;
    }
    if (password && password.length < 8) {
      setError(t("remoteSetupErrorPasswordShort" as never));
      return false;
    }
    if (password && password !== confirmPassword) {
      setError(t("remoteSetupErrorPasswordMismatch" as never));
      return false;
    }
    if (relayOption === "custom" && !customRelayUrl.trim()) {
      setError(t("remoteSetupErrorCustomRelayRequired" as never));
      return false;
    }

    try {
      // Update relay config if changed
      const relayUrl = getRelayUrl();
      const relayChanged =
        username !== relayConfig?.username || relayUrl !== relayConfig?.url;
      if (relayChanged) {
        await updateRelayConfig({ url: relayUrl, username });
      }

      // Configure with password if provided
      if (password) {
        await configure(password);
        // Keep password in memory for QR code generation
        setSavedPassword(password);
      }

      // Clear password fields after save
      setPassword("");
      setConfirmPassword("");
      setHasChanges(false);
      return true;
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("remoteSetupErrorSaveFailed" as never),
      );
      return false;
    }
  };

  const handleToggle = async (checked: boolean) => {
    setError(null);
    setIsSaving(true);

    try {
      if (checked) {
        // Turning on
        if (hasChanges) {
          // Has pending edits - save them first, then enable
          const saved = await saveChanges();
          if (!saved) {
            setIsSaving(false);
            return;
          }
          // configure() already enables, so we're done
          onSetupComplete?.();
        } else if (hasCredentials) {
          // No changes, just re-enable
          await enable();
          onSetupComplete?.();
        }
        // If no credentials and no changes, toggle does nothing
        // (they need to fill in the form first)
      } else {
        // Turning off
        await disable();
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("remoteSetupErrorUpdateFailed" as never),
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    const saved = await saveChanges();
    if (saved) {
      onSetupComplete?.();
    }
    setIsSaving(false);
  };

  const handleCopyUrl = async (url: string) => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3>{title}</h3>
            <p>{description}</p>
          </div>
        </div>
        <div className="flex items-center justify-center py-8 text-sm text-[var(--text-muted)]">
          {t("remoteSetupLoading" as never)}
        </div>
      </div>
    );
  }

  const status = getStatusDisplay(
    relayStatus?.status ?? null,
    isEnabled,
    hasCredentials,
    t,
  );

  // Build connect URL with query params (for manual entry - no password)
  const connectUrl = (() => {
    const params = new URLSearchParams();
    if (username) {
      params.set("u", username);
    }
    const relayUrl = getRelayUrl();
    if (relayUrl !== DEFAULT_RELAY_URL) {
      params.set("r", relayUrl);
    }
    const queryString = params.toString();
    return queryString ? `${CONNECT_URL}?${queryString}` : CONNECT_URL;
  })();

  // Build QR code URL with credentials in hash (for auto-login)
  const qrCodeUrl = (() => {
    if (!savedPassword || !username) return null;
    const hashParams = new URLSearchParams();
    hashParams.set("u", username);
    hashParams.set("p", savedPassword);
    const relayUrl = getRelayUrl();
    if (relayUrl !== DEFAULT_RELAY_URL) {
      hashParams.set("r", relayUrl);
    }
    return `${CONNECT_URL}#${hashParams.toString()}`;
  })();

  // Can show QR code when connected and we have the password in memory
  const canShowQRCode =
    isEnabled && relayStatus?.status === "waiting" && qrCodeUrl !== null;

  // Can toggle on if: has credentials OR has filled in required fields
  const canToggleOn = hasCredentials || (username && password);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <label className="relative inline-block w-11 h-6 shrink-0 cursor-pointer">
          <input
            type="checkbox"
            className="peer opacity-0 w-0 h-0"
            checked={isEnabled}
            onChange={(e) => handleToggle(e.target.checked)}
            disabled={isSaving || (!isEnabled && !canToggleOn)}
          />
          <span className="absolute cursor-pointer inset-0 bg-[var(--bg-hover)] border border-[var(--border-color)] transition-colors duration-200 rounded-full peer-checked:bg-[var(--accent-color,#3b82f6)] peer-checked:border-[var(--accent-color,#3b82f6)] before:absolute before:content-[''] before:h-[18px] before:w-[18px] before:left-0.5 before:bottom-0.5 before:bg-[var(--text-muted)] before:transition-transform before:duration-200 before:rounded-full peer-checked:before:translate-x-5 peer-checked:before:bg-white" />
        </label>
      </div>

      <form onSubmit={handleSave} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="remote-username">
            {t("remoteSetupUsername" as never)}
          </label>
          <input
            id="remote-username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
            placeholder={t("remoteSetupUsernamePlaceholder" as never)}
            minLength={3}
            maxLength={32}
            pattern="[a-z0-9][-a-z0-9]*[a-z0-9]|[a-z0-9]{1,2}"
            title={t("remoteSetupUsernameHint" as never)}
            autoComplete="username"
            disabled={isSaving}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="remote-password">
            {hasCredentials
              ? t("remoteSetupNewPassword" as never)
              : t("remoteSetupPassword" as never)}
          </label>
          <input
            id="remote-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={hasCredentials ? "••••••••" : ""}
            minLength={8}
            autoComplete="new-password"
            disabled={isSaving}
          />
        </div>

        {password && (
          <div className="flex flex-col gap-1">
            <label htmlFor="remote-confirm">
              {t("remoteSetupConfirmPassword" as never)}
            </label>
            <input
              id="remote-confirm"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              minLength={8}
              autoComplete="new-password"
              disabled={isSaving}
            />
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label htmlFor="relay-select">
            {t("remoteSetupRelayServer" as never)}
          </label>
          <select
            id="relay-select"
            value={relayOption}
            onChange={(e) => setRelayOption(e.target.value as RelayOption)}
            disabled={isSaving}
            className="cursor-pointer rounded-md border border-[var(--border-input)] bg-[var(--bg-input)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--focus-border)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="default">
              {t("remoteSetupRelayDefault" as never)}
            </option>
            <option value="custom">
              {t("remoteSetupRelayCustom" as never)}
            </option>
          </select>
        </div>

        {relayOption === "custom" && (
          <div className="flex flex-col gap-1">
            <label htmlFor="custom-relay-url">
              {t("remoteSetupCustomRelayUrl" as never)}
            </label>
            <input
              id="custom-relay-url"
              type="text"
              value={customRelayUrl}
              onChange={(e) => setCustomRelayUrl(e.target.value)}
              placeholder={t("remoteSetupCustomRelayPlaceholder" as never)}
              disabled={isSaving}
            />
          </div>
        )}

        <div className="flex flex-col gap-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
          <span className="text-xs font-medium text-[var(--text-muted)]">
            {t("remoteSetupStatus" as never)}
          </span>
          <span className={`status-indicator ${status.className}`}>
            {status.text}
          </span>
          {relayStatus?.error && (
            <span className="text-xs text-[var(--error-color)]">
              {relayStatus.error}
            </span>
          )}
        </div>

        {(error || hookError) && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-[var(--error-color)]">
            {error || hookError}
          </p>
        )}

        {isEnabled && username && (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-[var(--text-muted)]">
              {t("remoteSetupConnectFrom" as never)}
            </span>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md bg-[var(--bg-code)] px-2 py-1 font-mono text-xs">
                {connectUrl}
              </code>
              <button
                type="button"
                className="flex items-center justify-center rounded-md bg-transparent p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                onClick={() => handleCopyUrl(connectUrl)}
                title={t("remoteSetupCopyUrl" as never)}
              >
                {copied
                  ? t("remoteSetupCopied" as never)
                  : t("remoteSetupCopy" as never)}
              </button>
            </div>
          </div>
        )}

        {canShowQRCode && (
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              className="text-xs text-[var(--link-color)] hover:underline"
              onClick={() => setShowQRCode(!showQRCode)}
            >
              {showQRCode
                ? t("remoteSetupHideQr" as never)
                : t("remoteSetupShowQr" as never)}
            </button>
            {showQRCode && qrCodeUrl && (
              <div className="rounded-md border border-[var(--border-color)] bg-white p-3">
                <QRCode value={qrCodeUrl} size={200} />
                <p className="text-center text-[10px] text-[var(--text-dimmed)]">
                  {t("remoteSetupQrHint" as never)}
                </p>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-[var(--text-primary)]">
              {t("remoteSetupSessions" as never, { count: sessions.length })}
            </span>
            {sessions.length > 0 && (
              <button
                type="button"
                className="text-xs text-[var(--error-color)] hover:underline"
                onClick={() => revokeAllSessions()}
                disabled={isSaving}
              >
                {t("remoteSetupRevokeAll" as never)}
              </button>
            )}
          </div>
          {sessions.length === 0 ? (
            <p className="text-sm text-[var(--text-dimmed)]">
              {t("remoteSetupNoSessions" as never)}
            </p>
          ) : (
            <ul className="list-none m-0 flex flex-col gap-2 p-0">
              {sessions.map((session) => {
                const { browser, os } = session.userAgent
                  ? parseUserAgent(session.userAgent)
                  : {
                      browser: t("remoteSetupUnknownBrowser" as never),
                      os: t("remoteSetupUnknownOs" as never),
                    };
                const hasDeviceInfo = session.userAgent || session.origin;

                return (
                  <li
                    key={session.sessionId}
                    className="flex items-center justify-between rounded-sm bg-[var(--bg-secondary)] p-2"
                  >
                    <div className="flex flex-col gap-1 text-[10px] text-[var(--text-muted)]">
                      {hasDeviceInfo ? (
                        <>
                          <span className="font-medium text-[var(--text-primary)]">
                            {browser} · {os}
                          </span>
                          {session.origin && (
                            <code className="rounded-sm bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px]">
                              {session.origin}
                            </code>
                          )}
                          <span className="text-[10px] text-[var(--text-muted)]">
                            {t("remoteSetupCreated" as never, {
                              date: formatRelativeDateWithT(
                                session.createdAt,
                                t,
                              ),
                            })}{" "}
                            ·{" "}
                            {t("remoteSetupLastUsed" as never, {
                              date: formatRelativeDateWithT(
                                session.lastUsed,
                                t,
                              ),
                            })}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="text-[10px] text-[var(--text-muted)]">
                            {t("remoteSetupCreatedLabel" as never)}{" "}
                            {new Date(session.createdAt).toLocaleDateString()}
                          </span>
                          <span className="text-[10px] text-[var(--text-muted)]">
                            {t("remoteSetupLastUsedLabel" as never)}{" "}
                            {new Date(session.lastUsed).toLocaleDateString()}
                          </span>
                        </>
                      )}
                    </div>
                    <button
                      type="button"
                      className="cursor-pointer rounded-sm border border-[var(--border-color)] bg-transparent px-2 py-1 text-[10px] text-[var(--error-color)] transition-colors hover:bg-red-50 disabled:opacity-50"
                      onClick={() => revokeSession(session.sessionId)}
                      disabled={isSaving}
                    >
                      {t("remoteSetupRevoke" as never)}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="submit"
            className="rounded-md border border-[var(--border-color)] bg-transparent px-4 py-2 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
            disabled={isSaving || !hasChanges}
          >
            {isSaving
              ? t("remoteSetupSaving" as never)
              : t("remoteSetupSave" as never)}
          </button>
        </div>
      </form>
    </div>
  );
}
