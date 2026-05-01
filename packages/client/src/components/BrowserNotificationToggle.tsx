import { useBrowserNotifications } from "../hooks/useBrowserNotifications";
import { useI18n } from "../i18n";

/**
 * Toggle component for browser notification permission.
 * Allows desktop users to enable notifications without full push subscription.
 * Returns null on mobile devices (they should use push notifications instead).
 */
export function BrowserNotificationToggle() {
  const { t } = useI18n();
  const {
    isSupported,
    isMobile,
    isEnabled,
    isDenied,
    isRequesting,
    requestPermission,
    showNotification,
  } = useBrowserNotifications();

  // Don't show on mobile - they should use push notifications
  if (isMobile) {
    return null;
  }

  // Not supported in this browser (desktop but old browser)
  if (!isSupported) {
    return (
      <div className="flex items-center justify-between gap-4 p-3 bg-[var(--bg-code)] rounded-[var(--radius-md)]">
        <div className="flex-1 min-w-0">
          <strong className="block mb-1">Desktop Notifications</strong>
          <p className="m-0 [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
            {t("browserToggleUnsupported")}
          </p>
        </div>
      </div>
    );
  }

  // Permission denied - user must change in browser settings
  if (isDenied) {
    return (
      <div className="flex items-center justify-between gap-4 p-3 bg-[var(--bg-code)] rounded-[var(--radius-md)]">
        <div className="flex-1 min-w-0">
          <strong className="block mb-1">{t("browserToggleTitle")}</strong>
          <p className="text-[var(--error-color)] [font-size:var(--font-size-sm)] mt-1">
            {t("browserToggleBlocked")}
          </p>
        </div>
      </div>
    );
  }

  // Permission granted
  if (isEnabled) {
    const handleTest = () => {
      showNotification(t("browserToggleTestNotification"), {
        body: t("browserToggleTestBody"),
        icon: "/icon-192.png",
      });
    };

    return (
      <>
        <div className="flex items-center justify-between gap-4 p-3 bg-[var(--bg-code)] rounded-[var(--radius-md)]">
          <div className="flex-1 min-w-0">
            <strong className="block mb-1">{t("browserToggleTitle")}</strong>
            <p className="m-0 [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
              {t("browserToggleEnabled")}
            </p>
          </div>
          <span className="px-2 py-1 bg-[var(--success-color)] text-white rounded-[var(--radius-sm)] [font-size:var(--font-size-xs)] font-medium whitespace-nowrap">
            {t("browserToggleEnabledBadge")}
          </span>
        </div>
        <div className="flex items-center justify-between gap-4 p-3 bg-[var(--bg-code)] rounded-[var(--radius-md)]">
          <div className="flex-1 min-w-0">
            <strong className="block mb-1">
              {t("browserToggleTestTitle")}
            </strong>
            <p className="m-0 [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
              {t("browserToggleTestDescription")}
            </p>
          </div>
          <button
            type="button"
            className="px-3 py-2 bg-[var(--bg-hover)] border border-[var(--border-color)] rounded-[var(--radius-sm)] text-[var(--text-primary)] [font-size:var(--font-size-sm)] cursor-pointer transition-colors duration-150 whitespace-nowrap hover:bg-[var(--border-color)] disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleTest}
          >
            {t("pushToggleSendTest")}
          </button>
        </div>
      </>
    );
  }

  // Permission not yet requested (default state)
  return (
    <div className="flex items-center justify-between gap-4 p-3 bg-[var(--bg-code)] rounded-[var(--radius-md)]">
      <div className="flex-1 min-w-0">
        <strong className="block mb-1">{t("browserToggleTitle")}</strong>
        <p className="m-0 [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
          {t("browserToggleDescription")}
        </p>
      </div>
      <button
        type="button"
        className="px-3 py-2 bg-[var(--bg-hover)] border border-[var(--border-color)] rounded-[var(--radius-sm)] text-[var(--text-primary)] [font-size:var(--font-size-sm)] cursor-pointer transition-colors duration-150 whitespace-nowrap hover:bg-[var(--border-color)] disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={requestPermission}
        disabled={isRequesting}
      >
        {isRequesting ? t("browserToggleRequesting") : t("browserToggleEnable")}
      </button>
    </div>
  );
}
