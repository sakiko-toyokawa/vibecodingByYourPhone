import { useCallback, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

function loadStreamingEnabled(): boolean {
  const stored = localStorage.getItem(UI_KEYS.streamingEnabled);
  // Default to enabled
  if (stored === null) return true;
  return stored === "true";
}

function saveStreamingEnabled(enabled: boolean) {
  localStorage.setItem(UI_KEYS.streamingEnabled, String(enabled));
}

/**
 * Hook to manage streaming preference.
 * When enabled, assistant responses stream in token-by-token.
 * When disabled, responses appear all at once when complete.
 */
export function useStreamingEnabled() {
  const [streamingEnabled, setStreamingEnabledState] =
    useState<boolean>(loadStreamingEnabled);

  const setStreamingEnabled = useCallback((enabled: boolean) => {
    setStreamingEnabledState(enabled);
    saveStreamingEnabled(enabled);
  }, []);

  return { streamingEnabled, setStreamingEnabled };
}

/**
 * Get streaming preference without React state (for non-component code).
 */
export function getStreamingEnabled(): boolean {
  return loadStreamingEnabled();
}
