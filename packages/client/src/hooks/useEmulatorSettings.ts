import { useCallback, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

export type EmulatorQuality = "high" | "medium" | "low";

export const EMULATOR_FPS_OPTIONS = [15, 24, 30] as const;
export type EmulatorFps = (typeof EMULATOR_FPS_OPTIONS)[number];

export const EMULATOR_WIDTH_OPTIONS = [360, 540, 720] as const;
export type EmulatorWidth = (typeof EMULATOR_WIDTH_OPTIONS)[number];

const QUALITY_LABELS: Record<EmulatorQuality, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Map quality label to x264 CRF value (lower = better quality / higher bitrate). */
export const QUALITY_TO_CRF: Record<EmulatorQuality, number> = {
  high: 23,
  medium: 30,
  low: 35,
};

// ---------------------------------------------------------------------------
// Adaptive FPS constants — tune these to adjust adaptation behaviour.
// ---------------------------------------------------------------------------

/** Packet loss rate (0–1) above which fps is reduced. */
export const ADAPTIVE_LOSS_THRESHOLD = 0.05; // 5%

/** Frame rate to drop to when loss exceeds the threshold. */
export const ADAPTIVE_DEGRADED_FPS: EmulatorFps = 15;

/** Seconds of loss-free streaming required before stepping fps back up. */
export const ADAPTIVE_RECOVERY_SECONDS = 30;

/** How often (ms) the client polls WebRTC stats for adaptation decisions. */
export const ADAPTIVE_CHECK_INTERVAL_MS = 5000;

// ---------------------------------------------------------------------------

export function getQualityLabel(q: EmulatorQuality): string {
  return QUALITY_LABELS[q];
}

/** True when the device looks like a small touchscreen (phone/tablet). */
function isMobile(): boolean {
  return navigator.maxTouchPoints > 0 && window.innerWidth < 768;
}

function loadFps(): EmulatorFps {
  const v = Number.parseInt(
    localStorage.getItem(UI_KEYS.emulatorMaxFps) ?? "",
    10,
  );
  if ((EMULATOR_FPS_OPTIONS as readonly number[]).includes(v))
    return v as EmulatorFps;
  return isMobile() ? 15 : 30;
}

function loadWidth(): EmulatorWidth {
  const v = Number.parseInt(
    localStorage.getItem(UI_KEYS.emulatorMaxWidth) ?? "",
    10,
  );
  if ((EMULATOR_WIDTH_OPTIONS as readonly number[]).includes(v))
    return v as EmulatorWidth;
  return isMobile() ? 360 : 720;
}

function loadQuality(): EmulatorQuality {
  const v = localStorage.getItem(UI_KEYS.emulatorQuality);
  if (v === "high" || v === "medium" || v === "low") return v;
  return isMobile() ? "low" : "medium";
}

function loadAdaptiveFps(): boolean {
  const v = localStorage.getItem(UI_KEYS.emulatorAdaptiveFps);
  if (v === "true") return true;
  if (v === "false") return false;
  return true; // default on
}

/** Hook to read and persist emulator stream quality settings. */
export function useEmulatorSettings() {
  const [maxFps, setMaxFpsState] = useState<EmulatorFps>(loadFps);
  const [maxWidth, setMaxWidthState] = useState<EmulatorWidth>(loadWidth);
  const [quality, setQualityState] = useState<EmulatorQuality>(loadQuality);
  const [adaptiveFps, setAdaptiveFpsState] = useState<boolean>(loadAdaptiveFps);

  const setMaxFps = useCallback((fps: EmulatorFps) => {
    setMaxFpsState(fps);
    localStorage.setItem(UI_KEYS.emulatorMaxFps, String(fps));
  }, []);

  const setMaxWidth = useCallback((width: EmulatorWidth) => {
    setMaxWidthState(width);
    localStorage.setItem(UI_KEYS.emulatorMaxWidth, String(width));
  }, []);

  const setQuality = useCallback((q: EmulatorQuality) => {
    setQualityState(q);
    localStorage.setItem(UI_KEYS.emulatorQuality, q);
  }, []);

  const setAdaptiveFps = useCallback((v: boolean) => {
    setAdaptiveFpsState(v);
    localStorage.setItem(UI_KEYS.emulatorAdaptiveFps, String(v));
  }, []);

  return {
    maxFps,
    setMaxFps,
    maxWidth,
    setMaxWidth,
    quality,
    setQuality,
    adaptiveFps,
    setAdaptiveFps,
  };
}

/** Read current emulator settings without React state (for use in connect()). */
export function getEmulatorSettings(): {
  maxFps: EmulatorFps;
  maxWidth: EmulatorWidth;
  quality: EmulatorQuality;
  adaptiveFps: boolean;
} {
  return {
    maxFps: loadFps(),
    maxWidth: loadWidth(),
    quality: loadQuality(),
    adaptiveFps: loadAdaptiveFps(),
  };
}
