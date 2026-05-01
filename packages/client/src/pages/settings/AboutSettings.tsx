import { useCallback, useEffect, useState } from "react";
import { api, fetchJSON } from "../../api/client";
import { useOptionalRemoteConnection } from "../../contexts/RemoteConnectionContext";
import { useDeveloperMode } from "../../hooks/useDeveloperMode";
import { useOnboarding } from "../../hooks/useOnboarding";
import { usePwaInstall } from "../../hooks/usePwaInstall";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import { activityBus } from "../../lib/activityBus";

export function AboutSettings() {
  const { t } = useI18n();
  const { canInstall, isInstalled, install } = usePwaInstall();
  const {
    version: versionInfo,
    loading: versionLoading,
    error: versionError,
    refetchFresh: refetchVersionFresh,
  } = useVersion({ freshOnMount: true });
  const remoteConnection = useOptionalRemoteConnection();
  const { resetOnboarding } = useOnboarding();
  const { remoteLogCollectionEnabled, setRemoteLogCollectionEnabled } =
    useDeveloperMode();
  const isRelayConnection = !!remoteConnection?.currentRelayUsername;
  const hasResumeProtocolSupport =
    (versionInfo?.resumeProtocolVersion ?? 1) >= 2;
  const showRelayResumeUpdateWarning =
    isRelayConnection && !!versionInfo && !hasResumeProtocolSupport;

  // Server restart state
  const [restarting, setRestarting] = useState(false);
  const [activeWorkers, setActiveWorkers] = useState(0);

  // Fetch worker activity on mount
  useEffect(() => {
    fetchJSON<{ activeWorkers: number; hasActiveWork: boolean }>(
      "/status/workers",
    )
      .then((data) => setActiveWorkers(data.activeWorkers))
      .catch(() => {});
  }, []);

  // When activity bus reconnects after restart, clear restarting state
  useEffect(() => {
    if (!restarting) return;
    return activityBus.on("reconnect", () => {
      setRestarting(false);
    });
  }, [restarting]);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try {
      await api.restartServer();
    } catch {
      // Expected - server drops connection during restart
    }
  }, []);

  return (
    <section className="flex flex-col gap-8 mb-12">
      <h2
        style={{ fontFamily: "var(--font-display)" }}
        className="text-[2rem] text-[var(--text-primary)] mb-2"
      >
        {t("aboutTitle")}
      </h2>
      <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
        {/* Only show Install option if install is possible or already installed */}
        {(canInstall || isInstalled) && (
          <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
            <div className="flex flex-col gap-1">
              <strong>{t("aboutInstallTitle")}</strong>
              <p>
                {isInstalled
                  ? t("aboutInstalledDescription")
                  : t("aboutInstallDescription")}
              </p>
            </div>
            {isInstalled ? (
              <span className="px-[var(--space-2)] py-[var(--space-1)] rounded-[var(--radius-sm)] bg-[var(--text-primary)] text-white [font-size:var(--font-size-sm)] font-medium">
                {t("aboutInstalled")}
              </span>
            ) : (
              <button
                type="button"
                className="px-3 py-1.5 rounded-md border border-[var(--border-color)] bg-transparent text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
                onClick={install}
              >
                {t("aboutInstall")}
              </button>
            )}
          </div>
        )}
        <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
          <div className="flex flex-col gap-1">
            <strong>{t("aboutVersionTitle")}</strong>
            <p>
              {t("aboutServerVersion")}{" "}
              {versionInfo ? (
                <>
                  v{versionInfo.current}
                  {versionInfo.updateAvailable && versionInfo.latest ? (
                    <span className="text-[var(--success-color)] font-medium">
                      {" "}
                      {t("aboutVersionAvailable", {
                        version: versionInfo.latest,
                      })}
                    </span>
                  ) : versionInfo.latest ? (
                    <span className="text-[var(--text-muted)]">
                      {" "}
                      {t("aboutUpToDate")}
                    </span>
                  ) : null}
                </>
              ) : (
                t("loginLoading")
              )}
            </p>
            <p>
              {t("aboutClientVersion")} v{__APP_VERSION__}
            </p>
            {versionError && (
              <p className="text-xs text-[var(--warning-color)] mt-1">
                {t("aboutUnableRefresh")}
              </p>
            )}
            {showRelayResumeUpdateWarning && (
              <p className="text-xs text-[var(--warning-color)] mt-1">
                {t("aboutRelayResumeWarning")}
              </p>
            )}
            {versionInfo?.updateAvailable && (
              <p className="mt-[var(--space-1)] [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
                {t("aboutUpdateHint")}
              </p>
            )}
          </div>
          <button
            type="button"
            className="px-3 py-1.5 rounded-md border border-[var(--border-color)] bg-transparent text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
            onClick={() => void refetchVersionFresh()}
            disabled={versionLoading}
          >
            {versionLoading ? t("aboutChecking") : t("aboutCheckUpdates")}
          </button>
        </div>
        <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
          <div className="flex flex-col gap-1">
            <strong>{t("developmentRestartTitle")}</strong>
            <p>{t("developmentRestartDescription")}</p>
            {activeWorkers > 0 && !restarting && (
              <p className="text-xs text-[var(--warning-color)] mt-1">
                {t("developmentInterruptedWarning", {
                  count: activeWorkers,
                  suffix: activeWorkers !== 1 ? "s " : " ",
                })}
              </p>
            )}
          </div>
          <button
            type="button"
            className={`px-[var(--space-2)] py-[var(--space-2)] bg-[var(--bg-hover)] border border-[var(--border-color)] rounded-[var(--radius-sm)] text-[var(--text-primary)] [font-size:var(--font-size-sm)] cursor-pointer transition-[background] duration-150 whitespace-nowrap ${activeWorkers > 0 ? "bg-[var(--error-color)] border-[var(--error-color)] text-white hover:bg-[var(--error-hover,#b91c1c)] hover:border-[var(--error-hover,#b91c1c)]" : "hover:bg-[var(--border-color)]"}`}
            onClick={handleRestart}
            disabled={restarting}
          >
            {restarting
              ? t("developmentRestarting")
              : activeWorkers > 0
                ? t("developmentRestartAnyway")
                : t("developmentRestart")}
          </button>
        </div>
        <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
          <div className="flex flex-col gap-1">
            <strong>{t("aboutReportBugTitle")}</strong>
            <p>{t("aboutReportBugDescription")}</p>
          </div>
          <a
            href="https://github.com/kzahel/yepanywhere/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 rounded-md border border-[var(--border-color)] bg-transparent text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
          >
            {t("aboutReportBug")}
          </a>
        </div>
        <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
          <div className="flex flex-col gap-1">
            <strong>{t("aboutSetupWizardTitle")}</strong>
            <p>{t("aboutSetupWizardDescription")}</p>
          </div>
          <button
            type="button"
            className="px-3 py-1.5 rounded-md border border-[var(--border-color)] bg-transparent text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
            onClick={resetOnboarding}
          >
            {t("aboutLaunchWizard")}
          </button>
        </div>
        <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
          <div className="flex flex-col gap-1">
            <strong>{t("aboutDiagnosticsTitle")}</strong>
            <p>{t("aboutDiagnosticsDescription")}</p>
          </div>
          <label className="relative inline-block w-[44px] h-[24px] shrink-0">
            <input
              type="checkbox"
              className="opacity-0 w-0 h-0"
              checked={remoteLogCollectionEnabled}
              onChange={(e) => setRemoteLogCollectionEnabled(e.target.checked)}
            />
            <span className="absolute cursor-pointer inset-0 bg-[var(--bg-hover)] border border-[var(--border-color)] transition-[background-color,border-color] duration-200 rounded-full before:absolute before:content-[''] before:h-[18px] before:w-[18px] before:left-[2px] before:bottom-[2px] before:bg-[var(--text-muted)] before:transition-transform before:duration-200 before:rounded-full" />
          </label>
        </div>
      </div>
    </section>
  );
}
