import { useCallback, useEffect, useState } from "react";
import {
  LEGACY_KEYS,
  getServerScoped,
  setServerScoped,
} from "../lib/storageKeys";

/**
 * Read the notifyInApp setting from localStorage
 */
function getNotifyInAppSetting(): boolean {
  return getServerScoped("notifyInApp", LEGACY_KEYS.notifyInApp) === "true";
}

/**
 * Sync the notifyInApp setting to the service worker
 */
function syncSettingToServiceWorker(value: boolean) {
  if (!("serviceWorker" in navigator)) return;

  // Sync to current controller if available
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: "setting-update",
      key: "notifyInApp",
      value,
    });
  }

  // Also sync when SW becomes ready (handles SW restarts)
  navigator.serviceWorker.ready.then((registration) => {
    registration.active?.postMessage({
      type: "setting-update",
      key: "notifyInApp",
      value,
    });
  });
}

/**
 * Hook to sync notifyInApp setting to service worker on app startup.
 * Call this at the app level to ensure the setting persists across SW restarts.
 */
export function useSyncNotifyInAppSetting() {
  useEffect(() => {
    const value = getNotifyInAppSetting();
    syncSettingToServiceWorker(value);

    // Also handle when a new service worker takes over
    if ("serviceWorker" in navigator) {
      const handleControllerChange = () => {
        syncSettingToServiceWorker(getNotifyInAppSetting());
      };
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        handleControllerChange,
      );
      return () => {
        navigator.serviceWorker.removeEventListener(
          "controllerchange",
          handleControllerChange,
        );
      };
    }
  }, []);
}

/**
 * Hook to manage the "notify when in app" setting.
 * When enabled, notifications will show even when the app is focused,
 * as long as the specific session isn't being viewed.
 */
export function useNotifyInApp() {
  const [notifyInApp, setNotifyInAppState] = useState(getNotifyInAppSetting);

  // Sync setting to service worker whenever it changes
  useEffect(() => {
    syncSettingToServiceWorker(notifyInApp);
  }, [notifyInApp]);

  const setNotifyInApp = useCallback((value: boolean) => {
    setServerScoped("notifyInApp", String(value), LEGACY_KEYS.notifyInApp);
    setNotifyInAppState(value);
  }, []);

  return { notifyInApp, setNotifyInApp };
}
