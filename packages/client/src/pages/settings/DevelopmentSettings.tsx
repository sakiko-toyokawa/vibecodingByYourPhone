import { useEffect, useState } from "react";
import { useSchemaValidationContext } from "../../contexts/SchemaValidationContext";
import { useDeveloperMode } from "../../hooks/useDeveloperMode";
import { useReloadNotifications } from "../../hooks/useReloadNotifications";
import { useSchemaValidation } from "../../hooks/useSchemaValidation";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";

export function DevelopmentSettings() {
  const { t } = useI18n();
  const {
    isManualReloadMode,
    pendingReloads,
    connected,
    reloadBackend,
    unsafeToRestart,
    workerActivity,
  } = useReloadNotifications();
  const { settings: validationSettings, setEnabled: setValidationEnabled } =
    useSchemaValidation();
  const { holdModeEnabled, setHoldModeEnabled } = useDeveloperMode();
  const { ignoredTools, clearIgnoredTools } = useSchemaValidationContext();
  const { settings: serverSettings, updateSetting: updateServerSetting } =
    useServerSettings();

  const [restarting, setRestarting] = useState(false);
  // When SSE reconnects after restart, re-enable the button
  useEffect(() => {
    if (restarting && connected) {
      setRestarting(false);
    }
  }, [restarting, connected]);

  const handleRestartServer = async () => {
    setRestarting(true);
    await reloadBackend();
  };

  // Only render in manual reload mode (dev mode)
  if (!isManualReloadMode) {
    return null;
  }

  return (
    <section className="flex flex-col gap-8 mb-12">
      <h2
        style={{ fontFamily: "var(--font-display)" }}
        className="text-[2rem] text-[var(--text-primary)] mb-2"
      >
        {t("developmentSectionTitle")}
      </h2>

      <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
        <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
          <div className="flex flex-col gap-1">
            <strong>{t("developmentSchemaTitle")}</strong>
            <p>{t("developmentSchemaDescription")}</p>
          </div>
          <label className="relative inline-block w-[44px] h-[24px] shrink-0">
            <input
              type="checkbox"
              className="opacity-0 w-0 h-0"
              checked={validationSettings.enabled}
              onChange={(e) => setValidationEnabled(e.target.checked)}
            />
            <span className="absolute cursor-pointer inset-0 bg-[var(--bg-hover)] border border-[var(--border-color)] transition-[background-color,border-color] duration-200 rounded-full before:absolute before:content-[''] before:h-[18px] before:w-[18px] before:left-[2px] before:bottom-[2px] before:bg-[var(--text-muted)] before:transition-transform before:duration-200 before:rounded-full" />
          </label>
        </div>
        {ignoredTools.length > 0 && (
          <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
            <div className="flex flex-col gap-1">
              <strong>{t("developmentIgnoredToolsTitle")}</strong>
              <p>{t("developmentIgnoredToolsDescription")}</p>
              <div className="flex flex-wrap gap-[var(--space-1)] mt-[var(--space-2)]">
                {ignoredTools.map((tool) => (
                  <span
                    key={tool}
                    className="px-[var(--space-2)] py-[var(--space-1)] bg-[var(--bg-tertiary)] rounded-[var(--radius-sm)] [font-size:var(--font-size-xs)] text-[var(--text-secondary)] [font-family:var(--font-mono)]"
                  >
                    {tool}
                  </span>
                ))}
              </div>
            </div>
            <button
              type="button"
              className="px-[var(--space-2)] py-[var(--space-2)] bg-transparent border border-[var(--border-color)] rounded-[var(--radius-sm)] text-[var(--text-primary)] [font-size:var(--font-size-sm)] cursor-pointer transition-[background] duration-150 whitespace-nowrap hover:bg-[var(--bg-hover)]"
              onClick={clearIgnoredTools}
            >
              {t("developmentClearIgnored")}
            </button>
          </div>
        )}
        <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
          <div className="flex flex-col gap-1">
            <strong>{t("developmentHoldModeTitle")}</strong>
            <p>{t("developmentHoldModeDescription")}</p>
          </div>
          <label className="relative inline-block w-[44px] h-[24px] shrink-0">
            <input
              type="checkbox"
              className="opacity-0 w-0 h-0"
              checked={holdModeEnabled}
              onChange={(e) => setHoldModeEnabled(e.target.checked)}
            />
            <span className="absolute cursor-pointer inset-0 bg-[var(--bg-hover)] border border-[var(--border-color)] transition-[background-color,border-color] duration-200 rounded-full before:absolute before:content-[''] before:h-[18px] before:w-[18px] before:left-[2px] before:bottom-[2px] before:bg-[var(--text-muted)] before:transition-transform before:duration-200 before:rounded-full" />
          </label>
        </div>
        <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
          <div className="flex flex-col gap-1">
            <strong>{t("developmentServiceWorkerTitle")}</strong>
            <p>{t("developmentServiceWorkerDescription")}</p>
          </div>
          <label className="relative inline-block w-[44px] h-[24px] shrink-0">
            <input
              type="checkbox"
              className="opacity-0 w-0 h-0"
              checked={serverSettings?.serviceWorkerEnabled ?? true}
              onChange={(e) =>
                updateServerSetting("serviceWorkerEnabled", e.target.checked)
              }
            />
            <span className="absolute cursor-pointer inset-0 bg-[var(--bg-hover)] border border-[var(--border-color)] transition-[background-color,border-color] duration-200 rounded-full before:absolute before:content-[''] before:h-[18px] before:w-[18px] before:left-[2px] before:bottom-[2px] before:bg-[var(--text-muted)] before:transition-transform before:duration-200 before:rounded-full" />
          </label>
        </div>
      </div>

      <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
        <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
          <div className="flex flex-col gap-1">
            <strong>{t("developmentRestartTitle")}</strong>
            <p>
              {t("developmentRestartDescription")}
              {pendingReloads.backend && (
                <span className="text-[var(--warning-color)]">
                  {" "}
                  {t("developmentChangesPending")}
                </span>
              )}
            </p>
            {unsafeToRestart && (
              <p className="text-xs text-[var(--warning-color)] mt-1">
                {t("developmentInterruptedWarning", {
                  count: workerActivity.activeWorkers,
                  suffix: workerActivity.activeWorkers !== 1 ? "s " : " ",
                })}
              </p>
            )}
          </div>
          <button
            type="button"
            className={`px-[var(--space-2)] py-[var(--space-2)] border rounded-[var(--radius-sm)] [font-size:var(--font-size-sm)] cursor-pointer transition-[background] duration-150 whitespace-nowrap ${unsafeToRestart ? "bg-[var(--error-color)] border-[var(--error-color)] text-white hover:bg-[var(--error-hover,#b91c1c)] hover:border-[var(--error-hover,#b91c1c)]" : "bg-[var(--bg-hover)] border-[var(--border-color)] text-[var(--text-primary)] hover:bg-[var(--border-color)]"}`}
            onClick={handleRestartServer}
            disabled={restarting}
          >
            {restarting
              ? t("developmentRestarting")
              : unsafeToRestart
                ? t("developmentRestartAnyway")
                : t("developmentRestart")}
          </button>
        </div>
      </div>
    </section>
  );
}
