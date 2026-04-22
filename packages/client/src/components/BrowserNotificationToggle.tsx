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
      <div className="settings-item">
        <div className="settings-item-info">
          <strong>Desktop Notifications</strong>
          <p>{t("browserToggleUnsupported")}</p>
        </div>
      </div>
    );
  }

  // Permission denied - user must change in browser settings
  if (isDenied) {
    return (
      <div className="settings-item">
        <div className="settings-item-info">
          <strong>{t("browserToggleTitle")}</strong>
          <p className="settings-warning">{t("browserToggleBlocked")}</p>
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
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("browserToggleTitle")}</strong>
            <p>{t("browserToggleEnabled")}</p>
          </div>
          <span className="settings-badge settings-badge-success">
            {t("browserToggleEnabledBadge")}
          </span>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("browserToggleTestTitle")}</strong>
            <p>{t("browserToggleTestDescription")}</p>
          </div>
          <button
            type="button"
            className="settings-button"
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
    <div className="settings-item">
      <div className="settings-item-info">
        <strong>{t("browserToggleTitle")}</strong>
        <p>{t("browserToggleDescription")}</p>
      </div>
      <button
        type="button"
        className="settings-button"
        onClick={requestPermission}
        disabled={isRequesting}
      >
        {isRequesting ? t("browserToggleRequesting") : t("browserToggleEnable")}
      </button>
    </div>
  );
}
