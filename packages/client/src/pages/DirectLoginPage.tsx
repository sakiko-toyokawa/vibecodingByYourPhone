/**
 * DirectLoginPage - Direct connection form for remote access via SecureConnection.
 *
 * Collects server URL, username, and password for SRP authentication.
 * On successful auth, the app switches to the main view.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { YepAnywhereLogo } from "../components/YepAnywhereLogo";
import { useRemoteConnection } from "../contexts/RemoteConnectionContext";
import { useI18n } from "../i18n";
import { createDirectHost, loadSavedHosts, saveHost } from "../lib/hostStorage";

export function DirectLoginPage() {
  const { t } = useI18n();
  const {
    connect,
    isConnecting,
    isAutoResuming,
    error,
    storedUrl,
    storedUsername,
    hasStoredSession,
    resumeSession,
  } = useRemoteConnection();

  // Form state - pre-fill from stored credentials
  // All hooks must be before any conditional returns
  const [serverUrl, setServerUrl] = useState(
    storedUrl ?? "ws://localhost:3400/api/ws",
  );
  const [username, setUsername] = useState(storedUsername ?? "");
  const [password, setPassword] = useState("");
  // Always default to "remember me" - logout feature can be added later
  const [rememberMe, setRememberMe] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);

  // If auto-resume is in progress, show a loading screen
  if (isAutoResuming) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg-surface)] p-4">
        <div className="w-full max-w-[360px] p-4">
          <div className="mb-6 flex justify-center">
            <YepAnywhereLogo size="lg" />
          </div>
          <p className="m-0 mb-4 text-center text-base text-[var(--text-muted)]">
            {t("reconnecting")}
          </p>
          <div
            className="text-center text-[var(--text-muted)]"
            data-testid="auto-resume-loading"
          >
            <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-[var(--border-muted)] border-t-[var(--accent-rust)]" />
          </div>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    // Validate inputs
    if (!serverUrl.trim()) {
      setLocalError(t("directLoginErrorServerUrlRequired"));
      return;
    }

    if (!username.trim()) {
      setLocalError(t("directLoginErrorUsernameRequired"));
      return;
    }

    if (!password) {
      setLocalError(t("directLoginErrorPasswordRequired"));
      return;
    }

    // Normalize URL - ensure it's a WebSocket URL
    let wsUrl = serverUrl.trim();
    if (wsUrl.startsWith("http://")) {
      wsUrl = wsUrl.replace("http://", "ws://");
    } else if (wsUrl.startsWith("https://")) {
      wsUrl = wsUrl.replace("https://", "wss://");
    } else if (!wsUrl.startsWith("ws://") && !wsUrl.startsWith("wss://")) {
      wsUrl = `ws://${wsUrl}`;
    }

    // Ensure /api/ws path
    if (!wsUrl.endsWith("/api/ws")) {
      wsUrl = `${wsUrl.replace(/\/$/, "")}/api/ws`;
    }

    try {
      // If we have a stored session and credentials match, try to resume
      if (
        hasStoredSession &&
        rememberMe &&
        wsUrl === storedUrl &&
        username.trim() === storedUsername
      ) {
        await resumeSession(password);
      } else {
        await connect(wsUrl, username.trim(), password, rememberMe);
      }

      // Save host for quick reconnect (if rememberMe is enabled)
      if (rememberMe) {
        const existing = loadSavedHosts().hosts.find(
          (h) => h.mode === "direct" && h.wsUrl === wsUrl,
        );
        if (!existing) {
          const newHost = createDirectHost({
            wsUrl,
            srpUsername: username.trim(),
          });
          saveHost(newHost);
        }
      }
      // On success, the RemoteApp will render the main app instead of login
    } catch {
      // Error is already set in context
    }
  };

  const displayError = localError ?? error;

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-surface)] p-4">
      <div className="w-full max-w-[360px] p-4">
        <Link
          to="/login"
          className="mb-3 inline-flex items-center gap-1 text-sm text-[var(--text-muted)] no-underline hover:text-[var(--text-primary)]"
        >
          &larr; {t("actionBack")}
        </Link>

        <div className="mb-6 flex justify-center">
          <YepAnywhereLogo size="lg" />
        </div>
        <h1
          className="m-0 mb-4 text-center text-[1.75rem] text-[var(--text-primary)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("directLoginTitle")}
        </h1>

        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-3"
          data-testid="login-form"
        >
          <div className="flex flex-col gap-1">
            <label
              htmlFor="serverUrl"
              className="text-sm text-[var(--text-muted)]"
            >
              {t("directLoginServerUrl")}
            </label>
            <input
              id="serverUrl"
              type="text"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="ws://localhost:3400/api/ws"
              disabled={isConnecting}
              autoComplete="url"
              data-testid="ws-url-input"
              className="rounded-[var(--radius-md)] border border-[var(--border-input)] bg-[var(--bg-input)] px-3 py-2 text-base text-[var(--text-primary)] outline-none focus:border-[var(--focus-border)]"
            />
            <p className="m-0 text-xs text-[var(--text-dimmed)]">
              {t("directLoginServerUrlHint")}
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="username"
              className="text-sm text-[var(--text-muted)]"
            >
              {t("directLoginUsername")}
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t("directLoginUsernamePlaceholder")}
              disabled={isConnecting}
              autoComplete="username"
              data-testid="username-input"
              className="rounded-[var(--radius-md)] border border-[var(--border-input)] bg-[var(--bg-input)] px-3 py-2 text-base text-[var(--text-primary)] outline-none focus:border-[var(--focus-border)]"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="password"
              className="text-sm text-[var(--text-muted)]"
            >
              {t("directLoginPassword")}
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("directLoginPasswordPlaceholder")}
              disabled={isConnecting}
              autoComplete="current-password"
              data-testid="password-input"
              className="rounded-[var(--radius-md)] border border-[var(--border-input)] bg-[var(--bg-input)] px-3 py-2 text-base text-[var(--text-primary)] outline-none focus:border-[var(--focus-border)]"
            />
          </div>

          <div className="flex flex-row items-start gap-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--text-primary)]">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                disabled={isConnecting}
                data-testid="remember-me-checkbox"
                className="h-4 w-4 cursor-pointer accent-[var(--accent-rust)]"
              />
              <span>{t("directLoginRememberMe")}</span>
            </label>
            <p className="m-0 text-xs text-[var(--text-dimmed)]">
              {hasStoredSession
                ? t("directLoginResumeHint")
                : t("directLoginStayLoggedIn")}
            </p>
          </div>

          {displayError && (
            <div
              className="rounded-[var(--radius-md)] bg-[rgba(199,78,57,0.1)] p-2 text-center text-sm text-[var(--error-color)]"
              data-testid="login-error"
            >
              {displayError}
            </div>
          )}

          <button
            type="submit"
            className="cursor-pointer rounded-[var(--radius-md)] border-none bg-[var(--accent-rust)] px-4 py-2 text-base font-medium text-white transition-colors duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isConnecting}
            data-testid="login-button"
          >
            {isConnecting
              ? t("directLoginConnecting")
              : t("directLoginConnect")}
          </button>
        </form>

        <p className="mt-3 text-center text-sm text-[var(--text-dimmed)]">
          {t("directLoginHint")}
        </p>
      </div>
    </div>
  );
}
