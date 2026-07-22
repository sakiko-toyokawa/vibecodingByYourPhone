import { useCallback, useEffect, useState } from "react";

/**
 * Hook to manage PWA installation prompt.
 *
 * The browser fires a `beforeinstallprompt` event when the app meets PWA criteria
 * and can be installed. We capture this event and provide a way to trigger the
 * native install prompt later (e.g., from a settings button).
 */

// Extend Window to include the beforeinstallprompt event
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

declare global {
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }
}

// Store the deferred prompt globally so it persists across component remounts
let deferredPrompt: BeforeInstallPromptEvent | null = null;

export function usePwaInstall() {
  const [canInstall, setCanInstall] = useState(false);
  const [isInstalled, setIsInstalled] = useState(false);

  useEffect(() => {
    // Check if already installed (standalone mode)
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      // iOS Safari doesn't support display-mode, check navigator
      ("standalone" in navigator &&
        (navigator as { standalone?: boolean }).standalone === true);

    if (isStandalone) {
      setIsInstalled(true);
      return;
    }

    // If we already captured the prompt, enable the install button
    if (deferredPrompt) {
      setCanInstall(true);
    }

    // Listen for the install prompt event
    const handleBeforeInstallPrompt = (e: BeforeInstallPromptEvent) => {
      // Prevent the default browser install prompt
      e.preventDefault();
      // Store the event for later use
      deferredPrompt = e;
      setCanInstall(true);
    };

    // Listen for successful installation
    const handleAppInstalled = () => {
      setIsInstalled(true);
      setCanInstall(false);
      deferredPrompt = null;
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener(
        "beforeinstallprompt",
        handleBeforeInstallPrompt,
      );
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferredPrompt) {
      return false;
    }

    // Show the native install prompt
    await deferredPrompt.prompt();

    // Wait for the user's response
    const { outcome } = await deferredPrompt.userChoice;

    if (outcome === "accepted") {
      setCanInstall(false);
      deferredPrompt = null;
      return true;
    }

    return false;
  }, []);

  return {
    /** Whether the app can be installed (prompt is available) */
    canInstall,
    /** Whether the app is already installed (running in standalone mode) */
    isInstalled,
    /** Trigger the native install prompt */
    install,
  };
}
