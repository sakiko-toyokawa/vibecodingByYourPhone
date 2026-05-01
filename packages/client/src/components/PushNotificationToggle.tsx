import { useState } from "react";
import { useNotifyInApp } from "../hooks/useNotifyInApp";
import { usePushNotifications } from "../hooks/usePushNotifications";
import { useI18n } from "../i18n";

export type TestNotificationUrgency = "normal" | "persistent" | "silent";

/**
 * Toggle component for push notification settings.
 * Shows subscription status, toggle switch, and test button.
 */
export function PushNotificationToggle() {
  const { t } = useI18n();
  const {
    isSupported,
    isSubscribed,
    isLoading,
    error,
    permission,
    subscribe,
    unsubscribe,
    sendTest,
  } = usePushNotifications();
  const { notifyInApp, setNotifyInApp } = useNotifyInApp();
  const [testUrgency, setTestUrgency] =
    useState<TestNotificationUrgency>("normal");

  const handleToggle = async () => {
    if (isSubscribed) {
      await unsubscribe();
    } else {
      await subscribe();
    }
  };

  // Not supported - show message with reason and help link
  if (!isSupported) {
    // Check if this is specifically the dev mode SW disabled case
    const isDevModeDisabled = error?.includes(
      "Service worker disabled in dev mode",
    );

    return (
      <div className="flex items-center justify-between gap-4 p-3 bg-[var(--bg-code)] rounded-[var(--radius-md)]">
        <div className="flex-1 min-w-0">
          <strong className="block mb-1">{t("pushToggleTitle")}</strong>
          <p className="m-0 [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
            {error || t("pushToggleUnsupported")}
          </p>
          {isDevModeDisabled && (
            <div className="bg-[var(--bg-elevated)] border border-[var(--border-muted)] rounded-[var(--radius-md)] p-3 [font-size:var(--font-size-sm)] text-[var(--text-muted)] mt-2">
              <p className="m-0 mb-2">{t("pushToggleThisDeviceOnly")}</p>
              <p className="m-0">{t("pushToggleDevModeHint")}</p>
            </div>
          )}
          <p className="mt-2">
            <a
              href="https://github.com/kzahel/yepanywhere/blob/main/docs/push-notifications.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--link-color)]"
            >
              {t("pushToggleTroubleshooting")}
            </a>
          </p>
        </div>
      </div>
    );
  }

  // Permission denied - show how to fix
  if (permission === "denied") {
    return (
      <div className="flex items-center justify-between gap-4 p-3 bg-[var(--bg-code)] rounded-[var(--radius-md)]">
        <div className="flex-1 min-w-0">
          <strong className="block mb-1">{t("pushToggleTitle")}</strong>
          <p className="text-[var(--error-color)] [font-size:var(--font-size-sm)] mt-1">
            {t("pushToggleBlocked")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-4 p-3 bg-[var(--bg-code)] rounded-[var(--radius-md)]">
        <div className="flex-1 min-w-0">
          <strong className="block mb-1">{t("pushToggleTitle")}</strong>
          <p className="m-0 [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
            {t("pushToggleDescription")}
          </p>
          {error && (
            <p className="text-[var(--error-color)] [font-size:var(--font-size-sm)] mt-1">
              {error}
            </p>
          )}
        </div>
        <label className="relative inline-block w-11 h-6 shrink-0">
          <input
            type="checkbox"
            className="peer opacity-0 w-0 h-0"
            checked={isSubscribed}
            onChange={handleToggle}
            disabled={isLoading}
          />
          <span className="absolute cursor-pointer inset-0 bg-[var(--bg-hover)] border border-[var(--border-color)] transition-colors duration-200 rounded-full before:absolute before:content-[''] before:h-[18px] before:w-[18px] before:left-0.5 before:bottom-0.5 before:bg-[var(--text-muted)] before:transition-transform before:duration-200 before:rounded-full peer-checked:bg-[var(--accent-color,#3b82f6)] peer-checked:border-[var(--accent-color,#3b82f6)] peer-checked:before:translate-x-5 peer-checked:before:bg-white" />
        </label>
      </div>

      {isSubscribed && (
        <>
          <div className="flex items-center justify-between gap-4 p-3 bg-[var(--bg-code)] rounded-[var(--radius-md)]">
            <div className="flex-1 min-w-0">
              <strong className="block mb-1">
                {t("pushToggleNotifyInAppTitle")}
              </strong>
              <p className="m-0 [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
                {t("pushToggleNotifyInAppDescription")}
              </p>
            </div>
            <label className="relative inline-block w-11 h-6 shrink-0">
              <input
                type="checkbox"
                className="peer opacity-0 w-0 h-0"
                checked={notifyInApp}
                onChange={(e) => setNotifyInApp(e.target.checked)}
              />
              <span className="absolute cursor-pointer inset-0 bg-[var(--bg-hover)] border border-[var(--border-color)] transition-colors duration-200 rounded-full before:absolute before:content-[''] before:h-[18px] before:w-[18px] before:left-0.5 before:bottom-0.5 before:bg-[var(--text-muted)] before:transition-transform before:duration-200 before:rounded-full peer-checked:bg-[var(--accent-color,#3b82f6)] peer-checked:border-[var(--accent-color,#3b82f6)] peer-checked:before:translate-x-5 peer-checked:before:bg-white" />
            </label>
          </div>
          <div className="flex items-center justify-between gap-4 p-3 bg-[var(--bg-code)] rounded-[var(--radius-md)]">
            <div className="flex-1 min-w-0">
              <strong className="block mb-1">{t("pushToggleTestTitle")}</strong>
              <p className="m-0 [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
                {t("pushToggleTestDescription")}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <select
                className="px-3 py-2 bg-[var(--bg-hover)] border border-[var(--border-color)] rounded-[var(--radius-sm)] text-[var(--text-primary)] [font-size:var(--font-size-sm)] cursor-pointer min-w-[160px] hover:bg-[var(--border-color)] disabled:opacity-50 disabled:cursor-not-allowed"
                value={testUrgency}
                onChange={(e) =>
                  setTestUrgency(e.target.value as TestNotificationUrgency)
                }
                disabled={isLoading}
              >
                <option value="normal">{t("pushToggleUrgencyNormal")}</option>
                <option value="persistent">
                  {t("pushToggleUrgencyPersistent")}
                </option>
                <option value="silent">{t("pushToggleUrgencySilent")}</option>
              </select>
              <button
                type="button"
                className="px-3 py-2 bg-[var(--bg-hover)] border border-[var(--border-color)] rounded-[var(--radius-sm)] text-[var(--text-primary)] [font-size:var(--font-size-sm)] cursor-pointer transition-colors duration-150 whitespace-nowrap hover:bg-[var(--border-color)] disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() => sendTest(testUrgency)}
                disabled={isLoading}
              >
                {isLoading ? t("pushToggleSending") : t("pushToggleSendTest")}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
