import type { AgentActivity } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef } from "react";
import { type ProcessStateEvent, activityBus } from "../lib/activityBus";
import { UI_KEYS } from "../lib/storageKeys";

/**
 * Check if running inside the Tauri desktop app.
 */
function isDesktopApp(): boolean {
  const token =
    typeof window !== "undefined"
      ? (window as Window & { __DESKTOP_TOKEN__?: string }).__DESKTOP_TOKEN__
      : undefined;
  console.log(
    "[DesktopNotify] isDesktopApp:",
    typeof window !== "undefined",
    "token:",
    !!token,
  );
  return typeof window !== "undefined" && token !== undefined;
}

/**
 * Check if desktop native notifications are enabled in settings.
 */
function getDesktopNotificationSetting(): boolean {
  try {
    return localStorage.getItem(UI_KEYS.desktopNativeNotifications) === "true";
  } catch {
    return false;
  }
}

/**
 * Play a short notification beep using Web Audio API.
 * Falls back silently if audio context is not available.
 */
function playNotificationSound(): void {
  try {
    const AudioCtx =
      (window as Window & { AudioContext?: typeof AudioContext })
        .AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, ctx.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(
      440,
      ctx.currentTime + 0.15,
    );

    gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.15);

    // Clean up after sound finishes
    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 200);
  } catch {
    // Silently fail if audio is not available
  }
}

/**
 * Send a native desktop notification via Tauri.
 * Lazy-loads the Tauri notification module to avoid errors in non-Tauri environments.
 */
async function sendNativeNotification(
  title: string,
  body: string,
): Promise<void> {
  console.log("[DesktopNotify] sendNativeNotification called");
  try {
    const { isPermissionGranted, requestPermission, sendNotification } =
      await import("@tauri-apps/plugin-notification");

    const permissionGranted = await isPermissionGranted();
    console.log("[DesktopNotify] permissionGranted:", permissionGranted);
    if (!permissionGranted) {
      const permission = await requestPermission();
      console.log("[DesktopNotify] permission after request:", permission);
      if (permission !== "granted") {
        return;
      }
    }

    console.log("[DesktopNotify] Sending notification...");
    sendNotification({ title, body });
    console.log("[DesktopNotify] Notification sent");
  } catch (err) {
    console.error(
      "[useDesktopNativeNotifications] Failed to send notification:",
      err,
    );
  }
}

/**
 * Hook that sends native desktop notifications when AI output completes.
 *
 * Listens to process-state-changed events from the activity bus.
 * When a session transitions from "in-turn" (AI generating) to "idle"
 * (AI done), and the app is not visible (minimized/background), a
 * system notification is shown with a sound cue.
 *
 * Only active inside the Tauri desktop app.
 */
export function useDesktopNativeNotifications(): void {
  const lastActivityMap = useRef<Map<string, AgentActivity>>(new Map());
  const lastNotifyTime = useRef<Map<string, number>>(new Map());

  const handleProcessStateChange = useCallback((event: ProcessStateEvent) => {
    console.log(
      "[DesktopNotify] process-state-changed:",
      event.sessionId.slice(0, 8),
      event.activity,
    );

    // Only run inside Tauri desktop app
    if (!isDesktopApp()) {
      console.log("[DesktopNotify] Not desktop app, skipping");
      return;
    }

    // Check setting
    const settingEnabled = getDesktopNotificationSetting();
    console.log("[DesktopNotify] Setting enabled:", settingEnabled);
    if (!settingEnabled) {
      console.log("[DesktopNotify] Setting disabled, skipping");
      return;
    }

    const previous = lastActivityMap.current.get(event.sessionId);
    const current = event.activity;
    lastActivityMap.current.set(event.sessionId, current);
    console.log("[DesktopNotify] State transition:", previous, "->", current);

    // Detect AI completion: in-turn -> idle
    if (previous !== "in-turn" || current !== "idle") {
      console.log("[DesktopNotify] Not in-turn->idle, skipping");
      return;
    }

    // Skip if app is visible and focused (user is actively looking at it)
    // Note: In Tauri, document.visibilityState may remain "visible" even when
    // the window is hidden. We rely on the user having the setting enabled.
    console.log("[DesktopNotify] visibilityState:", document.visibilityState);

    // Debounce: don't notify the same session within 5 seconds
    const now = Date.now();
    const lastTime = lastNotifyTime.current.get(event.sessionId) ?? 0;
    if (now - lastTime < 5000) {
      console.log("[DesktopNotify] Debounced, skipping");
      return;
    }
    lastNotifyTime.current.set(event.sessionId, now);

    console.log("[DesktopNotify] Sending notification!");
    // Send notification
    void sendNativeNotification("AI 回复完成", "AI 已生成新的回复，点击查看");

    // Play sound
    playNotificationSound();
  }, []);

  useEffect(() => {
    if (!isDesktopApp()) return;

    const unsubscribe = activityBus.on(
      "process-state-changed",
      handleProcessStateChange,
    );

    return () => {
      unsubscribe();
    };
  }, [handleProcessStateChange]);
}
