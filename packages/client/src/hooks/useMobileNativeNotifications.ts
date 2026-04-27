import { useCallback, useEffect, useRef } from "react";
import {
  type ProcessStateEvent,
  type SessionUpdatedEvent,
  activityBus,
} from "../lib/activityBus";
import { UI_KEYS } from "../lib/storageKeys";

/**
 * Check if running inside the Tauri mobile app.
 * Mobile Tauri has TAURI_INTERNALS but not DESKTOP_TOKEN.
 */
function isMobileTauriApp(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as Window & {
    __TAURI_INTERNALS__?: unknown;
    __DESKTOP_TOKEN__?: string;
  };
  return (
    w.__TAURI_INTERNALS__ !== undefined && w.__DESKTOP_TOKEN__ === undefined
  );
}

/**
 * Check if native notifications are enabled in settings.
 */
function getNotificationSetting(): boolean {
  try {
    return localStorage.getItem(UI_KEYS.desktopNativeNotifications) === "true";
  } catch {
    return false;
  }
}

/**
 * Send a native mobile notification via Tauri.
 * Lazy-loads the Tauri notification module to avoid errors in non-Tauri environments.
 */
async function sendNativeNotification(
  title: string,
  body: string,
): Promise<void> {
  try {
    const { isPermissionGranted, requestPermission, sendNotification } =
      await import("@tauri-apps/plugin-notification");

    const permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      const permission = await requestPermission();
      if (permission !== "granted") {
        return;
      }
    }

    sendNotification({ title, body });
  } catch (err) {
    console.error(
      "[useMobileNativeNotifications] Failed to send notification:",
      err,
    );
  }
}

/**
 * Hook that sends native mobile notifications when AI output completes
 * or when human approval is needed.
 *
 * Listens to process-state-changed events from the activity bus.
 * When a session transitions:
 * - "in-turn" -> "idle": AI has completed its response
 * - any -> "waiting-input": AI needs human approval or answer
 *
 * Only active inside the Tauri mobile app and when the app is not visible.
 */
export function useMobileNativeNotifications(): void {
  const lastActivityMap = useRef<Map<string, string>>(new Map());
  const lastNotifyTime = useRef<Map<string, number>>(new Map());
  const sessionTitles = useRef<Map<string, string>>(new Map());

  const handleProcessStateChange = useCallback(
    (event: ProcessStateEvent) => {
      // Only run inside Tauri mobile app
      if (!isMobileTauriApp()) {
        return;
      }

      // Check setting
      const settingEnabled = getNotificationSetting();
      if (!settingEnabled) {
        return;
      }

      const previous = lastActivityMap.current.get(event.sessionId);
      const current = event.activity;
      lastActivityMap.current.set(event.sessionId, current);

      // Skip if app is visible (user is actively looking at it)
      if (document.visibilityState === "visible") {
        return;
      }

      // Debounce: don't notify the same session within 5 seconds
      const now = Date.now();
      const lastTime = lastNotifyTime.current.get(event.sessionId) ?? 0;
      if (now - lastTime < 5000) {
        return;
      }

      const title = sessionTitles.current.get(event.sessionId) || "Yep Anywhere";

      // Detect AI completion: in-turn -> idle
      if (previous === "in-turn" && current === "idle") {
        lastNotifyTime.current.set(event.sessionId, now);
        void sendNativeNotification(title, "AI 已生成新的回复");
        return;
      }

      // Detect waiting for human input: any -> waiting-input
      if (current === "waiting-input") {
        lastNotifyTime.current.set(event.sessionId, now);
        const body =
          event.pendingInputType === "tool-approval"
            ? "AI 请求执行工具，需要你的确认"
            : "AI 向你提出问题，需要你的回复";
        void sendNativeNotification(title, body);
      }
    },
    [],
  );

  const handleSessionUpdated = useCallback(
    (event: SessionUpdatedEvent) => {
      if (event.title !== undefined && event.title !== null) {
        sessionTitles.current.set(event.sessionId, event.title);
      }
    },
    [],
  );

  useEffect(() => {
    if (!isMobileTauriApp()) return;

    const unsubProcess = activityBus.on(
      "process-state-changed",
      handleProcessStateChange,
    );
    const unsubSession = activityBus.on(
      "session-updated",
      handleSessionUpdated,
    );

    return () => {
      unsubProcess();
      unsubSession();
    };
  }, [handleProcessStateChange, handleSessionUpdated]);
}
