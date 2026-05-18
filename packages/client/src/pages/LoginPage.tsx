/**
 * LoginPage - Login form for cookie-based auth.
 *
 * Shows setup form when no account exists,
 * otherwise shows login form.
 */

import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { YepAnywhereLogo } from "../components/YepAnywhereLogo";
import { useAuth } from "../contexts/AuthContext";
import { useI18n } from "../i18n";

export function LoginPage() {
  const { t } = useI18n();
  const {
    isSetupMode,
    login,
    setupAccount,
    isLoading,
    authEnabled,
    authDisabledByEnv,
  } = useAuth();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  // Get the page they were trying to access before being redirected
  const from =
    (location.state as { from?: string } | null)?.from ?? "/projects";

  // If auth is not enabled or disabled by env, redirect away from login page
  useEffect(() => {
    if (!isLoading && (!authEnabled || authDisabledByEnv)) {
      navigate("/projects", { replace: true });
    }
  }, [isLoading, authEnabled, authDisabledByEnv, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!password) {
      setError(t("loginErrorPasswordRequired"));
      return;
    }

    if (isSetupMode) {
      if (password.length < 8) {
        setError(t("loginErrorPasswordTooShort"));
        return;
      }
      if (password !== confirmPassword) {
        setError(t("loginErrorPasswordMismatch"));
        return;
      }
    }

    setIsSubmitting(true);

    try {
      if (isSetupMode) {
        await setupAccount(password);
      } else {
        await login(password);
      }
      navigate(from, { replace: true });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t("loginErrorAuthFailed");
      setError(
        message.includes("401") ? t("loginErrorInvalidPassword") : message,
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg-surface)] p-4">
        <div className="w-full max-w-[360px] p-4">
          <div className="text-[var(--text-muted)] text-center">
            {t("loginLoading")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg-surface)] p-4">
      <div className="w-full max-w-[360px] p-4">
        <div className="mb-6 flex justify-center">
          <YepAnywhereLogo size="lg" />
        </div>
        <h1
          className="mb-2 text-center text-[1.75rem] text-[var(--text-primary)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {isSetupMode ? t("loginSetupSubtitle") : t("loginSubtitle")}
        </h1>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="password"
              className="text-sm text-[var(--text-muted)]"
            >
              {t("loginPasswordLabel")}
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={
                isSetupMode
                  ? t("loginPasswordPlaceholderSetup")
                  : t("loginPasswordPlaceholder")
              }
              disabled={isSubmitting}
              className="px-3 py-2 border border-[var(--border-input)] rounded-[var(--radius-md)] bg-[var(--bg-input)] text-[var(--text-primary)] text-base focus:outline-none focus:border-[var(--focus-border)]"
            />
          </div>

          {isSetupMode && (
            <div className="flex flex-col gap-1">
              <label
                htmlFor="confirmPassword"
                className="text-sm text-[var(--text-muted)]"
              >
                {t("loginConfirmPasswordLabel")}
              </label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder={t("loginConfirmPasswordPlaceholder")}
                disabled={isSubmitting}
                className="px-3 py-2 border border-[var(--border-input)] rounded-[var(--radius-md)] bg-[var(--bg-input)] text-[var(--text-primary)] text-base focus:outline-none focus:border-[var(--focus-border)]"
              />
            </div>
          )}

          {error && (
            <div className="text-[var(--error-color)] text-sm text-center p-2 bg-[var(--bg-error)] rounded-[var(--radius-md)]">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="cursor-pointer rounded-[var(--radius-md)] border-none bg-[var(--accent-rust)] px-4 py-2 text-base font-medium text-white transition-colors duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isSubmitting}
          >
            {isSubmitting
              ? t("loginSubmitPending")
              : isSetupMode
                ? t("loginSubmitSetup")
                : t("loginSubmit")}
          </button>
        </form>

        {isSetupMode && (
          <p className="text-xs text-[var(--text-dimmed)] text-center mt-3">
            {t("loginSetupHint")}
          </p>
        )}

        {!isSetupMode && (
          <p className="text-xs text-[var(--text-dimmed)] text-center mt-3">
            {t("loginRecoveryHint")}
          </p>
        )}
      </div>
    </div>
  );
}
