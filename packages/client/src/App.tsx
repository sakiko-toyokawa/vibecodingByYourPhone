import { type ReactNode, useEffect } from "react";
import { ConnectionBar } from "./components/ConnectionBar";
import { FloatingActionButton } from "./components/FloatingActionButton";
import { ReloadBanner } from "./components/ReloadBanner";
import { OnboardingWizard } from "./components/onboarding";
import { AuthProvider } from "./contexts/AuthContext";
import { InboxProvider } from "./contexts/InboxContext";
import { ProviderThemeProvider } from "./contexts/ProviderThemeContext";
import { SchemaValidationProvider } from "./contexts/SchemaValidationContext";
import { ToastProvider } from "./contexts/ToastContext";
import { useActiveProvider } from "./hooks/useActiveProvider";
import { useActivityBusConnection } from "./hooks/useActivityBusConnection";
import { useDesktopNativeNotifications } from "./hooks/useDesktopNativeNotifications";
import { useMobileNativeNotifications } from "./hooks/useMobileNativeNotifications";
import { useNeedsAttentionBadge } from "./hooks/useNeedsAttentionBadge";
import { useSyncNotifyInAppSetting } from "./hooks/useNotifyInApp";
import { useOnboarding } from "./hooks/useOnboarding";
import { useReloadNotifications } from "./hooks/useReloadNotifications";
import { I18nProvider } from "./i18n";
import { initClientLogCollection } from "./lib/diagnostics";

interface Props {
  children: ReactNode;
}

/**
 * Inner component that uses hooks requiring InboxContext.
 */
function AppContent({ children }: Props) {
  const activeProvider = useActiveProvider();

  // Manage SSE connection based on auth state (prevents 401s on login page)
  useActivityBusConnection();

  // Desktop native notifications when AI output completes
  useDesktopNativeNotifications();

  // Mobile native notifications when AI completes or needs approval
  useMobileNativeNotifications();

  // Client-side log collection for connection diagnostics
  useEffect(() => initClientLogCollection(), []);

  // Sync notifyInApp setting to service worker on app startup and SW restarts
  useSyncNotifyInAppSetting();

  // Update tab title with needs-attention badge count (uses InboxContext)
  useNeedsAttentionBadge();

  const {
    isManualReloadMode,
    pendingReloads,
    reloadBackend,
    reloadFrontend,
    dismiss,
    unsafeToRestart,
    workerActivity,
  } = useReloadNotifications();

  return (
    <ProviderThemeProvider activeProvider={activeProvider}>
      <>
        <ConnectionBar />
        {isManualReloadMode && pendingReloads.backend && (
          <ReloadBanner
            target="backend"
            onReload={reloadBackend}
            onDismiss={() => dismiss("backend")}
            unsafeToRestart={unsafeToRestart}
            activeWorkers={workerActivity.activeWorkers}
          />
        )}
        {isManualReloadMode && pendingReloads.frontend && (
          <ReloadBanner
            target="frontend"
            onReload={reloadFrontend}
            onDismiss={() => dismiss("frontend")}
          />
        )}
        {children}
        <FloatingActionButton />
      </>
    </ProviderThemeProvider>
  );
}

/**
 * App wrapper that provides global functionality like reload notifications, toasts,
 * and schema validation.
 */
export function App({ children }: Props) {
  const { showWizard, isLoading, completeOnboarding } = useOnboarding();

  return (
    <I18nProvider>
      <ToastProvider>
        <AuthProvider>
          <InboxProvider>
            <SchemaValidationProvider>
              <AppContent>{children}</AppContent>
              {!isLoading && showWizard && (
                <OnboardingWizard onComplete={completeOnboarding} />
              )}
            </SchemaValidationProvider>
          </InboxProvider>
        </AuthProvider>
      </ToastProvider>
    </I18nProvider>
  );
}
