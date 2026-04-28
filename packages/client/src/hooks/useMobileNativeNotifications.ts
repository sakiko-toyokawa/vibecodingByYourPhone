import { useCallback, useEffect, useRef } from "react";
import {
  type ProcessStateEvent,
  type SessionUpdatedEvent,
  activityBus,
} from "../lib/activityBus";
import { UI_KEYS } from "../lib/storageKeys";

/**
 * Send a debug log line to Rust so it appears in logcat (release build
 * WebView console.log is invisible).
 */
function logToRust(msg: string): void {
  try {
    void import("@tauri-apps/api/core").then(({ invoke }) => {
      void invoke("notify_debug_log", { msg });
    });
  } catch {
    // ignore — if Tauri is not available, nothing to log to
  }
}

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
  const result =
    w.__TAURI_INTERNALS__ !== undefined && w.__DESKTOP_TOKEN__ === undefined;
  logToRust(`isMobileTauriApp: ${result}`);
  return result;
}

/**
 * Check if native notifications are enabled in settings.
 */
function getNotificationSetting(): boolean {
  try {
    const value = localStorage.getItem(UI_KEYS.desktopNativeNotifications);
    logToRust(`setting value: ${value}`);
    return value === "true";
  } catch {
    logToRust("getNotificationSetting: exception -> false");
    return false;
  }
}

/**
 * Create the default notification channel for Android with vibration enabled.
 * Required on Android 8+ (API 26+). Without a channel, notifications are silently dropped.
 *
 * Android Channel behavior note: once a channel is created, its properties (importance,
 * vibration, etc.) cannot be changed. To update properties, we must remove and recreate.
 */
async function ensureNotificationChannel(): Promise<void> {
  try {
    // Use type assertion because dynamic import type inference is incomplete
    // for this plugin, but these APIs exist at runtime.
    const mod = (await import("@tauri-apps/plugin-notification")) as unknown as {
      createChannel: (channel: {
        id: string;
        name: string;
        description?: string;
        importance?: number;
        visibility?: number;
        vibration?: boolean;
      }) => Promise<void>;
      removeChannel: (id: string) => Promise<void>;
      channels: () => Promise<Array<{ id: string }>>;
    };
    const existing = await mod.channels();
    logToRust(`existing channels: ${JSON.stringify(existing)}`);

    // Remove old channel if exists (so we can recreate with new settings)
    if (existing.some((c) => c.id === "default")) {
      await mod.removeChannel("default");
      logToRust("Removed old default channel");
    }

    // Create channel with High importance + vibration enabled
    await mod.createChannel({
      id: "default",
      name: "Default",
      description: "Default notification channel",
      importance: 4, // IMPORTANCE_HIGH - triggers sound + vibration
      visibility: 0, // VISIBILITY_PRIVATE
      vibration: true,
    });
    logToRust("Created default channel with vibration");
  } catch (err) {
    logToRust(`Failed to create channel: ${err}`);
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
  logToRust(`sendNativeNotification called: ${title} | ${body}`);
  try {
    const { isPermissionGranted, requestPermission, sendNotification } =
      await import("@tauri-apps/plugin-notification");

    const permissionGranted = await isPermissionGranted();
    logToRust(`permissionGranted: ${permissionGranted}`);
    if (!permissionGranted) {
      const permission = await requestPermission();
      logToRust(`permission after request: ${permission}`);
      if (permission !== "granted") {
        logToRust("permission denied, aborting");
        return;
      }
    }

    logToRust("Calling sendNotification...");
    // Cast options to include channelId since dynamic import type inference is incomplete
    sendNotification({ title, body, channelId: "default" } as Parameters<typeof sendNotification>[0]);
    logToRust("sendNotification returned");
  } catch (err) {
    logToRust(`sendNativeNotification ERROR: ${err}`);
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
 */
export function useMobileNativeNotifications(): void {
  const lastActivityMap = useRef<Map<string, string>>(new Map());
  const lastNotifyTime = useRef<Map<string, number>>(new Map());
  const sessionTitles = useRef<Map<string, string>>(new Map());

  const handleProcessStateChange = useCallback((event: ProcessStateEvent) => {
    logToRust(
      `process-state-changed: ${event.sessionId.slice(0, 8)} -> ${event.activity}`,
    );

    // Only run inside Tauri mobile app
    if (!isMobileTauriApp()) {
      logToRust("Not mobile app, skipping");
      return;
    }

    // Check setting
    const settingEnabled = getNotificationSetting();
    logToRust(`Setting enabled: ${settingEnabled}`);
    if (!settingEnabled) {
      logToRust("Setting disabled, skipping");
      return;
    }

    const previous = lastActivityMap.current.get(event.sessionId);
    const current = event.activity;
    lastActivityMap.current.set(event.sessionId, current);
    logToRust(`State transition: ${previous} -> ${current}`);

    // Debounce: don't notify the same session within 5 seconds
    const now = Date.now();
    const lastTime = lastNotifyTime.current.get(event.sessionId) ?? 0;
    if (now - lastTime < 5000) {
      logToRust("Debounced, skipping");
      return;
    }

    const title = sessionTitles.current.get(event.sessionId) || "Yep Anywhere";
    logToRust(`Session title: ${title}`);

    // Detect AI completion: in-turn -> idle
    if (previous === "in-turn" && current === "idle") {
      lastNotifyTime.current.set(event.sessionId, now);
      logToRust("AI completed -> sending notification");
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
      logToRust("Waiting for input -> sending notification");
      void sendNativeNotification(title, body);
    }
  }, []);

  const handleSessionUpdated = useCallback((event: SessionUpdatedEvent) => {
    logToRust(`session-updated: ${event.sessionId.slice(0, 8)} title=${event.title}`);
    if (event.title !== undefined && event.title !== null) {
      sessionTitles.current.set(event.sessionId, event.title);
    }
  }, []);

  useEffect(() => {
    logToRust("useEffect running");
    if (!isMobileTauriApp()) {
      logToRust("Not mobile, skipping subscription");
      return;
    }

    // Create notification channel early (with vibration enabled)
    void ensureNotificationChannel();

    logToRust("Subscribing to activity events");
    const unsubProcess = activityBus.on(
      "process-state-changed",
      handleProcessStateChange,
    );
    const unsubSession = activityBus.on(
      "session-updated",
      handleSessionUpdated,
    );

    logToRust(`activityBus.connected = ${activityBus.connected}`);

    // Expose a manual test function for debugging
    (window as Window & { __testMobileNotify?: () => void }).__testMobileNotify =
      async () => {
        logToRust("Manual test triggered (JS API)");
        await sendNativeNotification(
          "JS 测试通知",
          "如果你看到这个，说明 JS → Bridge → Rust → Android 全链路工作正常",
        );
        logToRust("Calling Rust test_notification command...");
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("test_notification");
          logToRust("Rust command invoked");
        } catch (err) {
          logToRust(`Rust invoke failed: ${err}`);
        }
      };

    return () => {
      logToRust("Cleanup: unsubscribing");
      unsubProcess();
      unsubSession();
    };
  }, [handleProcessStateChange, handleSessionUpdated]);
}
