import { useState } from "react";
import { useNotifyInApp } from "../hooks/useNotifyInApp";
import { usePushNotifications } from "../hooks/usePushNotifications";
import { useI18n } from "../i18n";
import { SettingsSwitch } from "./settings/SettingsFormControls";

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
        <SettingsSwitch
          checked={isSubscribed}
          onChange={() => {
            void handleToggle();
          }}
          disabled={isLoading}
          ariaLabel={t("pushToggleTitle")}
        />
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
            <SettingsSwitch
              checked={notifyInApp}
              onChange={setNotifyInApp}
              ariaLabel={t("pushToggleNotifyInAppTitle")}
            />
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
