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
      <div className="login-page">
        <div className="login-container">
          <div className="login-loading">{t("loginLoading")}</div>
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
        <p className="login-subtitle">
          {isSetupMode ? t("loginSetupSubtitle") : t("loginSubtitle")}
        </p>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="login-field">
            <label htmlFor="password">{t("loginPasswordLabel")}</label>
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
            />
          </div>

          {isSetupMode && (
            <div className="login-field">
              <label htmlFor="confirmPassword">
                {t("loginConfirmPasswordLabel")}
              </label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder={t("loginConfirmPasswordPlaceholder")}
                disabled={isSubmitting}
              />
            </div>
          )}

          {error && <div className="login-error">{error}</div>}

          <button
            type="submit"
            className="login-button"
            disabled={isSubmitting}
          >
            {isSubmitting
              ? t("loginSubmitPending")
              : isSetupMode
                ? t("loginSubmitSetup")
                : t("loginSubmit")}
          </button>
        </form>

        {isSetupMode && <p className="login-hint">{t("loginSetupHint")}</p>}

        {!isSetupMode && (
          <p className="login-recovery-hint">{t("loginRecoveryHint")}</p>
        )}
      </div>
    </div>
  );
}
