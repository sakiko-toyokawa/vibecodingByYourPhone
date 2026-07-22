import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { authEvents } from "../lib/authEvents";

interface OnboardingState {
  /** Whether to show the wizard (not complete or manually reset) */
  showWizard: boolean;
  /** Whether we're still fetching initial state from server */
  isLoading: boolean;
}

// Module-level event bus so all useOnboarding() instances stay in sync
type Listener = (showWizard: boolean) => void;
const listeners = new Set<Listener>();
function notifyAll(showWizard: boolean) {
  for (const listener of listeners) listener(showWizard);
}

/**
 * Hook to manage onboarding wizard state.
 * Fetches completion status from server and provides methods to complete/reset.
 */
export function useOnboarding() {
  const [state, setState] = useState<OnboardingState>({
    showWizard: false,
    isLoading: true,
  });

  // Subscribe to cross-instance state changes
  useEffect(() => {
    const listener: Listener = (showWizard) => {
      setState((prev) => ({ ...prev, showWizard }));
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  // Fetch initial onboarding status from server
  useEffect(() => {
    let cancelled = false;

    async function fetchStatus() {
      // Don't fetch if on login page or login is required (prevents 401s)
      if (window.location.pathname === "/login" || authEvents.loginRequired) {
        if (!cancelled) {
          setState({ showWizard: false, isLoading: false });
        }
        return;
      }

      try {
        const { complete } = await api.getOnboardingStatus();
        if (!cancelled) {
          setState({ showWizard: !complete, isLoading: false });
        }
      } catch (error) {
        // If API fails (e.g., endpoint not available or 401), don't show wizard
        console.warn("Failed to fetch onboarding status:", error);
        if (!cancelled) {
          setState({ showWizard: false, isLoading: false });
        }
      }
    }

    fetchStatus();

    // Re-check when login required state changes (after successful login)
    const unsubscribe = authEvents.onLoginRequired(() => {
      if (!cancelled) {
        setState({ showWizard: false, isLoading: false });
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Mark onboarding as complete
  const completeOnboarding = useCallback(async () => {
    try {
      await api.completeOnboarding();
      setState((prev) => ({ ...prev, showWizard: false }));
      notifyAll(false);
    } catch (error) {
      console.error("Failed to complete onboarding:", error);
      // Still hide wizard on error to avoid blocking user
      setState((prev) => ({ ...prev, showWizard: false }));
      notifyAll(false);
    }
  }, []);

  // Reset onboarding to show wizard again
  const resetOnboarding = useCallback(async () => {
    try {
      await api.resetOnboarding();
      setState((prev) => ({ ...prev, showWizard: true }));
      notifyAll(true);
    } catch (error) {
      console.error("Failed to reset onboarding:", error);
    }
  }, []);

  return {
    showWizard: state.showWizard,
    isLoading: state.isLoading,
    completeOnboarding,
    resetOnboarding,
  };
}
