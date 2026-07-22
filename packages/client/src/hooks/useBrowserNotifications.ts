import { useCallback, useEffect, useState } from "react";
import { isMobileDevice } from "../lib/deviceDetection";

interface BrowserNotificationState {
  /** Whether the browser supports direct notifications (not mobile) */
  isSupported: boolean;
  /** Whether this is a mobile device */
  isMobile: boolean;
  /** Current notification permission status */
  permission: NotificationPermission;
  /** Whether permission is being requested */
  isRequesting: boolean;
}

/**
 * Hook for managing browser notification permission (without web push).
 *
 * This enables desktop notifications using the browser's Notification API directly,
 * without requiring service workers or push subscriptions. Useful for:
 * - In-app notifications when the tab is in the background
 * - Desktop users who want notifications without mobile push setup
 *
 * Note: These notifications only work while the tab is open.
 * For notifications when the browser is closed, use push notifications instead.
 */
export function useBrowserNotifications() {
  const [state, setState] = useState<BrowserNotificationState>(() => {
    const hasNotificationApi =
      typeof window !== "undefined" && "Notification" in window;
    const mobile = isMobileDevice();

    return {
      // Desktop notifications only work on non-mobile devices
      isSupported: hasNotificationApi && !mobile,
      isMobile: mobile,
      permission: hasNotificationApi ? Notification.permission : "denied",
      isRequesting: false,
    };
  });

  // Update permission if it changes (e.g., user changes in browser settings)
  useEffect(() => {
    if (!state.isSupported) return;

    // Check permission periodically in case user changed it in browser settings
    const checkPermission = () => {
      const current = Notification.permission;
      if (current !== state.permission) {
        setState((s) => ({ ...s, permission: current }));
      }
    };

    // Check on focus (user may have changed settings in another tab)
    window.addEventListener("focus", checkPermission);
    return () => window.removeEventListener("focus", checkPermission);
  }, [state.isSupported, state.permission]);

  /**
   * Request notification permission from the user.
   * Shows the browser's permission dialog.
   */
  const requestPermission = useCallback(async () => {
    if (!state.isSupported) return;
    if (state.permission === "granted") return;

    setState((s) => ({ ...s, isRequesting: true }));

    try {
      const permission = await Notification.requestPermission();
      setState((s) => ({
        ...s,
        permission,
        isRequesting: false,
      }));
    } catch (err) {
      console.error(
        "[useBrowserNotifications] Permission request failed:",
        err,
      );
      setState((s) => ({ ...s, isRequesting: false }));
    }
  }, [state.isSupported, state.permission]);

  /**
   * Show a browser notification (if permission granted).
   * Returns true if notification was shown, false otherwise.
   */
  const showNotification = useCallback(
    (title: string, options?: NotificationOptions): boolean => {
      if (!state.isSupported || state.permission !== "granted") {
        return false;
      }

      try {
        new Notification(title, options);
        return true;
      } catch (err) {
        console.error(
          "[useBrowserNotifications] Failed to show notification:",
          err,
        );
        return false;
      }
    },
    [state.isSupported, state.permission],
  );

  return {
    ...state,
    /** Whether notifications are enabled (permission granted) */
    isEnabled: state.permission === "granted",
    /** Whether permission has been denied (user must change in browser settings) */
    isDenied: state.permission === "denied",
    /** Request notification permission */
    requestPermission,
    /** Show a notification (requires permission) */
    showNotification,
  };
}
