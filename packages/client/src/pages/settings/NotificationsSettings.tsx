import { useCallback, useState } from "react";
import { BrowserNotificationToggle } from "../../components/BrowserNotificationToggle";
import { PushNotificationToggle } from "../../components/PushNotificationToggle";
import { useBrowserNotifications } from "../../hooks/useBrowserNotifications";
import { useConnectedDevices } from "../../hooks/useConnectedDevices";
import { useNotificationSettings } from "../../hooks/useNotificationSettings";
import { usePushNotifications } from "../../hooks/usePushNotifications";
import {
  type SubscribedDevice,
  useSubscribedDevices,
} from "../../hooks/useSubscribedDevices";
import { useI18n } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";

/**
 * Unified device that merges subscribed device info with connection status.
 */
interface UnifiedDevice {
  browserProfileId: string;
  /** Device name from push subscription, or truncated UUID */
  displayName: string;
  /** Browser type suffix (e.g., "(Android/Chrome)") */
  browserType: string;
  /** True if device has push subscription */
  isSubscribed: boolean;
  /** True if device is currently connected */
  isConnected: boolean;
  /** Number of connected tabs (0 if not connected) */
  tabCount: number;
  /** Subscription date (if subscribed) */
  subscribedAt?: string;
  /** True if this is the current device */
  isCurrentDevice: boolean;
}

/**
 * Format a device name with its domain for display.
 * Returns the display name and browser type separately.
 */
function formatDeviceName(
  deviceName: string | undefined,
  endpointDomain: string | undefined,
): { displayName: string; browserType: string } {
  const name = deviceName || "Unknown device";

  // Extract push service type from domain
  if (endpointDomain?.includes("google")) {
    return { displayName: name, browserType: "(Android/Chrome)" };
  }
  if (
    endpointDomain?.includes("apple") ||
    endpointDomain?.includes("push.apple")
  ) {
    return { displayName: name, browserType: "(iOS/Safari)" };
  }
  if (
    endpointDomain?.includes("mozilla") ||
    endpointDomain?.includes("push.services.mozilla")
  ) {
    return { displayName: name, browserType: "(Firefox)" };
  }
  return { displayName: name, browserType: "" };
}

/**
 * Format a date string to a relative or absolute format.
 */
function formatDate(
  dateString: string,
  t: (key: never, vars?: Record<string, string | number>) => string,
): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return new Date().toLocaleDateString();
  }
  if (diffDays === 1) {
    return new Date(Date.now() - 86400000).toLocaleDateString();
  }
  if (diffDays < 7) {
    return t("hostPickerLastConnectedDays" as never, { count: diffDays });
  }
  return date.toLocaleDateString();
}

/**
 * Merge subscribed devices with connected devices into a unified list.
 * Sorts: current device first, then connected devices, then offline subscribed.
 */
function mergeDevices(
  subscribedDevices: SubscribedDevice[],
  connectedDevices: Map<
    string,
    { connectionCount: number; deviceName?: string }
  >,
  currentBrowserProfileId: string | null,
): UnifiedDevice[] {
  const deviceMap = new Map<string, UnifiedDevice>();

  // Add subscribed devices first
  for (const device of subscribedDevices) {
    const { displayName, browserType } = formatDeviceName(
      device.deviceName,
      device.endpointDomain,
    );
    const connection = connectedDevices.get(device.browserProfileId);

    deviceMap.set(device.browserProfileId, {
      browserProfileId: device.browserProfileId,
      displayName,
      browserType,
      isSubscribed: true,
      isConnected: !!connection,
      tabCount: connection?.connectionCount ?? 0,
      subscribedAt: device.createdAt,
      isCurrentDevice: device.browserProfileId === currentBrowserProfileId,
    });
  }

  // Add connected-but-not-subscribed devices
  for (const [browserProfileId, connection] of connectedDevices) {
    if (!deviceMap.has(browserProfileId)) {
      // Not subscribed, show truncated UUID
      const truncatedId = browserProfileId.slice(0, 8);
      deviceMap.set(browserProfileId, {
        browserProfileId,
        displayName: truncatedId,
        browserType: "",
        isSubscribed: false,
        isConnected: true,
        tabCount: connection.connectionCount,
        isCurrentDevice: browserProfileId === currentBrowserProfileId,
      });
    }
  }

  // Convert to array and sort
  const devices = Array.from(deviceMap.values());

  devices.sort((a, b) => {
    // Current device first
    if (a.isCurrentDevice && !b.isCurrentDevice) return -1;
    if (!a.isCurrentDevice && b.isCurrentDevice) return 1;

    // Then connected devices (sorted by tab count descending)
    if (a.isConnected && !b.isConnected) return -1;
    if (!a.isConnected && b.isConnected) return 1;
    if (a.isConnected && b.isConnected) {
      return b.tabCount - a.tabCount;
    }

    // Then offline subscribed (sorted by subscription date, newest first)
    if (a.subscribedAt && b.subscribedAt) {
      return (
        new Date(b.subscribedAt).getTime() - new Date(a.subscribedAt).getTime()
      );
    }

    return 0;
  });

  return devices;
}

export function NotificationsSettings() {
  const { t } = useI18n();
  const { browserProfileId } = usePushNotifications();
  const { isMobile } = useBrowserNotifications();
  const {
    devices: subscribedDevices,
    isLoading: devicesLoading,
    removeDevice,
  } = useSubscribedDevices();
  const { connections, isLoading: connectionsLoading } = useConnectedDevices();
  const {
    settings,
    isLoading: settingsLoading,
    updateSetting,
  } = useNotificationSettings();

  const hasSubscriptions = subscribedDevices.length > 0;
  const isLoading = devicesLoading || connectionsLoading;

  // Tauri native notification setting (shared between desktop and mobile)
  const isDesktopTauri =
    typeof window !== "undefined" &&
    (window as Window & { __DESKTOP_TOKEN__?: string }).__DESKTOP_TOKEN__ !==
      undefined;
  const isMobileTauri =
    typeof window !== "undefined" &&
    (window as Window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__ !== undefined &&
    (window as Window & { __DESKTOP_TOKEN__?: string }).__DESKTOP_TOKEN__ ===
      undefined;
  const [desktopNotifyEnabled, setDesktopNotifyEnabled] = useState(() => {
    try {
      return (
        localStorage.getItem(UI_KEYS.desktopNativeNotifications) === "true"
      );
    } catch {
      return false;
    }
  });
  const toggleDesktopNotify = useCallback(() => {
    const next = !desktopNotifyEnabled;
    try {
      localStorage.setItem(UI_KEYS.desktopNativeNotifications, String(next));
    } catch {
      // Ignore storage errors
    }
    setDesktopNotifyEnabled(next);
  }, [desktopNotifyEnabled]);

  // Merge subscribed and connected devices
  const unifiedDevices = mergeDevices(
    subscribedDevices,
    connections,
    browserProfileId,
  );

  return (
    <>
      {/* Server-side settings - what types of notifications are sent */}
      <section className="flex flex-col gap-8 mb-12">
        <h2
          style={{ fontFamily: "var(--font-display)" }}
          className="text-[2rem] text-[var(--text-primary)] mb-2"
        >
          {t("notificationsServerTitle")}
        </h2>
        <p className="m-0 mb-[var(--space-3)] [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
          {t("notificationsServerDescription")}
        </p>
        <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
          <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
            <div className="flex flex-col gap-1">
              <strong>{t("notificationsToolApprovalsTitle")}</strong>
              <p>{t("notificationsToolApprovalsDescription")}</p>
            </div>
            <label className="relative inline-block w-[44px] h-[24px] shrink-0">
              <input
                type="checkbox"
                className="opacity-0 w-0 h-0"
                checked={settings?.toolApproval ?? true}
                onChange={(e) =>
                  updateSetting("toolApproval", e.target.checked)
                }
                disabled={settingsLoading || !hasSubscriptions}
              />
              <span className="absolute cursor-pointer inset-0 bg-[var(--bg-hover)] border border-[var(--border-color)] transition-[background-color,border-color] duration-200 rounded-full before:absolute before:content-[''] before:h-[18px] before:w-[18px] before:left-[2px] before:bottom-[2px] before:bg-[var(--text-muted)] before:transition-transform before:duration-200 before:rounded-full" />
            </label>
          </div>

          <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
            <div className="flex flex-col gap-1">
              <strong>{t("notificationsQuestionsTitle")}</strong>
              <p>{t("notificationsQuestionsDescription")}</p>
            </div>
            <label className="relative inline-block w-[44px] h-[24px] shrink-0">
              <input
                type="checkbox"
                className="opacity-0 w-0 h-0"
                checked={settings?.userQuestion ?? true}
                onChange={(e) =>
                  updateSetting("userQuestion", e.target.checked)
                }
                disabled={settingsLoading || !hasSubscriptions}
              />
              <span className="absolute cursor-pointer inset-0 bg-[var(--bg-hover)] border border-[var(--border-color)] transition-[background-color,border-color] duration-200 rounded-full before:absolute before:content-[''] before:h-[18px] before:w-[18px] before:left-[2px] before:bottom-[2px] before:bg-[var(--text-muted)] before:transition-transform before:duration-200 before:rounded-full" />
            </label>
          </div>

          <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
            <div className="flex flex-col gap-1">
              <strong>{t("notificationsSessionHaltedTitle")}</strong>
              <p>{t("notificationsSessionHaltedDescription")}</p>
            </div>
            <label className="relative inline-block w-[44px] h-[24px] shrink-0">
              <input
                type="checkbox"
                className="opacity-0 w-0 h-0"
                checked={settings?.sessionHalted ?? true}
                onChange={(e) =>
                  updateSetting("sessionHalted", e.target.checked)
                }
                disabled={settingsLoading || !hasSubscriptions}
              />
              <span className="absolute cursor-pointer inset-0 bg-[var(--bg-hover)] border border-[var(--border-color)] transition-[background-color,border-color] duration-200 rounded-full before:absolute before:content-[''] before:h-[18px] before:w-[18px] before:left-[2px] before:bottom-[2px] before:bg-[var(--text-muted)] before:transition-transform before:duration-200 before:rounded-full" />
            </label>
          </div>

          {!hasSubscriptions && !devicesLoading && (
            <p className="text-[var(--text-muted)] [font-size:var(--font-size-sm)] p-[var(--space-2)]">
              {t("notificationsNoSubscribedDevices")}
            </p>
          )}
        </div>
      </section>

      {/* Desktop notifications - browser Notification API (not available on mobile) */}
      {!isMobile && (
        <section className="flex flex-col gap-8 mb-12">
          <h2
            style={{ fontFamily: "var(--font-display)" }}
            className="text-[2rem] text-[var(--text-primary)] mb-2"
          >
            {t("notificationsDesktopTitle")}
          </h2>
          <p className="m-0 mb-[var(--space-3)] [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
            {t("notificationsDesktopDescription")}
          </p>
          <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
            <BrowserNotificationToggle />
            {isDesktopTauri && (
              <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
                <div className="flex flex-col gap-1">
                  <strong>{t("desktopNativeNotifyTitle")}</strong>
                  <p>{t("desktopNativeNotifyDescription")}</p>
                </div>
                <label className="relative inline-block w-[44px] h-[24px] shrink-0">
                  <input
                    type="checkbox"
                    className="opacity-0 w-0 h-0"
                    checked={desktopNotifyEnabled}
                    onChange={toggleDesktopNotify}
                  />
                  <span className="absolute cursor-pointer inset-0 bg-[var(--bg-hover)] border border-[var(--border-color)] transition-[background-color,border-color] duration-200 rounded-full before:absolute before:content-[''] before:h-[18px] before:w-[18px] before:left-[2px] before:bottom-[2px] before:bg-[var(--text-muted)] before:transition-transform before:duration-200 before:rounded-full" />
                </label>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Mobile native notifications - Tauri plugin (only on mobile Tauri app) */}
      {isMobile && isMobileTauri && (
        <section className="flex flex-col gap-8 mb-12">
          <h2
            style={{ fontFamily: "var(--font-display)" }}
            className="text-[2rem] text-[var(--text-primary)] mb-2"
          >
            {t("notificationsNativeTitle")}
          </h2>
          <p className="m-0 mb-[var(--space-3)] [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
            {t("notificationsNativeDescription")}
          </p>
          <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
            <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
              <div className="flex flex-col gap-1">
                <strong>{t("mobileNativeNotifyTitle")}</strong>
                <p>{t("mobileNativeNotifyDescription")}</p>
              </div>
              <label className="relative inline-block w-[44px] h-[24px] shrink-0">
                <input
                  type="checkbox"
                  className="opacity-0 w-0 h-0"
                  checked={desktopNotifyEnabled}
                  onChange={toggleDesktopNotify}
                />
                <span className="absolute cursor-pointer inset-0 bg-[var(--bg-hover)] border border-[var(--border-color)] transition-[background-color,border-color] duration-200 rounded-full before:absolute before:content-[''] before:h-[18px] before:w-[18px] before:left-[2px] before:bottom-[2px] before:bg-[var(--text-muted)] before:transition-transform before:duration-200 before:rounded-full" />
              </label>
            </div>
          </div>
        </section>
      )}

      {/* Push notifications - service worker based */}
      <section className="flex flex-col gap-8 mb-12">
        <h2
          style={{ fontFamily: "var(--font-display)" }}
          className="text-[2rem] text-[var(--text-primary)] mb-2"
        >
          {t("notificationsPushTitle")}
        </h2>
        <p className="m-0 mb-[var(--space-3)] [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
          {t("notificationsPushDescription")}
        </p>
        <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
          <PushNotificationToggle />
        </div>
      </section>

      {/* Unified devices list */}
      <section className="flex flex-col gap-8 mb-12">
        <h2
          style={{ fontFamily: "var(--font-display)" }}
          className="text-[2rem] text-[var(--text-primary)] mb-2"
        >
          {t("notificationsDevicesTitle")}
        </h2>
        <p className="m-0 mb-[var(--space-3)] [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
          {t("notificationsDevicesDescription")}
        </p>
        <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
          {isLoading ? (
            <p className="text-[var(--text-muted)] [font-size:var(--font-size-sm)] p-[var(--space-2)]">
              {t("notificationsLoadingDevices")}
            </p>
          ) : unifiedDevices.length === 0 ? (
            <p className="text-[var(--text-muted)] [font-size:var(--font-size-sm)] p-[var(--space-2)]">
              {t("notificationsNoDevices")}
            </p>
          ) : (
            <div className="flex flex-col gap-[var(--space-2)]">
              {unifiedDevices.map((device) => (
                <div
                  key={device.browserProfileId}
                  className="flex items-center justify-between gap-[var(--space-3)] p-[var(--space-3)] bg-[var(--bg-elevated)] border border-[var(--border-muted)] rounded-[var(--radius-md)]"
                >
                  <div className="flex-1 min-w-0">
                    <strong className="flex items-center gap-[var(--space-2)] [font-size:var(--font-size-base)]">
                      {device.displayName}
                      {device.browserType && ` ${device.browserType}`}
                      {device.isCurrentDevice && (
                        <span className="[font-size:var(--font-size-xs)] font-medium px-[6px] py-[2px] bg-[var(--text-primary)] text-white rounded-[var(--radius-sm)]">
                          {t("notificationsThisDevice")}
                        </span>
                      )}
                    </strong>
                    <p className="m-[var(--space-1)]_0_0 [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
                      {/* Status indicator */}
                      {device.isConnected ? (
                        <span className="mr-[var(--space-2)] before:content-[''] before:inline-block before:w-2 before:h-2 before:rounded-full before:bg-[var(--success-color)] before:mr-1 before:align-middle">
                          {device.tabCount === 1
                            ? t("notificationsOneTab")
                            : t("notificationsTabs", {
                                count: device.tabCount,
                              })}
                        </span>
                      ) : (
                        <span className="mr-[var(--space-2)] before:content-[''] before:inline-block before:w-2 before:h-2 before:rounded-full before:bg-[var(--text-muted)] before:mr-1 before:align-middle">
                          {t("notificationsOffline")}
                        </span>
                      )}
                      {/* No push indicator for connected-only devices */}
                      {!device.isSubscribed && (
                        <span className="[font-size:var(--font-size-xs)] px-1 py-[1px] bg-[var(--bg-muted)] border border-[var(--border-muted)] rounded-[var(--radius-sm)] text-[var(--text-muted)] ml-[var(--space-2)]">
                          {t("notificationsNoPush")}
                        </span>
                      )}
                      {/* Subscription date for subscribed devices */}
                      {device.subscribedAt && (
                        <span className="ml-[var(--space-2)] text-[var(--text-muted)]">
                          {t("notificationsSubscribed", {
                            date: formatDate(device.subscribedAt, t),
                          })}
                        </span>
                      )}
                    </p>
                  </div>
                  {/* Only show remove button for subscribed devices */}
                  {device.isSubscribed && (
                    <button
                      type="button"
                      className="px-[var(--space-2)] py-[var(--space-2)] bg-transparent border border-[var(--error-color)] rounded-[var(--radius-sm)] text-[var(--error-color)] [font-size:var(--font-size-sm)] cursor-pointer transition-[background,color] duration-150 whitespace-nowrap hover:bg-[var(--error-color)] hover:text-white"
                      onClick={() => removeDevice(device.browserProfileId)}
                      title={
                        device.isCurrentDevice
                          ? t("notificationsRemoveThisDevice")
                          : t("notificationsRemoveDevice")
                      }
                    >
                      {t("notificationsRemove")}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
