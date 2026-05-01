import { useState } from "react";
import {
  EMULATOR_FPS_OPTIONS,
  EMULATOR_WIDTH_OPTIONS,
  type EmulatorQuality,
  getQualityLabel,
  useEmulatorSettings,
} from "../../hooks/useEmulatorSettings";
import { useEmulators } from "../../hooks/useEmulators";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";

const QUALITY_OPTIONS: EmulatorQuality[] = ["high", "medium", "low"];

function canStartDevice(type: string, state: string, actions?: string[]) {
  if (actions?.length) return actions.includes("start");
  return type === "emulator" && state === "stopped";
}

function canStopDevice(type: string, state: string, actions?: string[]) {
  if (actions?.length) return actions.includes("stop");
  return type === "emulator" && state !== "stopped";
}

/**
 * Settings section for the device bridge.
 * Shows discovered devices, stream settings, and ChromeOS host aliases.
 */
export function EmulatorSettings() {
  const { t } = useI18n();
  const { emulators, loading, error, startEmulator, stopEmulator, refresh } =
    useEmulators();
  const {
    maxFps,
    setMaxFps,
    maxWidth,
    setMaxWidth,
    quality,
    setQuality,
    adaptiveFps,
    setAdaptiveFps,
  } = useEmulatorSettings();
  const {
    settings,
    isLoading: settingsLoading,
    error: settingsError,
    updateSetting,
  } = useServerSettings();
  const [hostInput, setHostInput] = useState("");
  const [chromeOsHostError, setChromeOsHostError] = useState<string | null>(
    null,
  );

  const chromeOsHosts = settings?.chromeOsHosts ?? [];

  const addHost = async () => {
    const value = hostInput.trim();
    if (!value) {
      setChromeOsHostError(t("emulatorHostAliasRequired"));
      return;
    }
    if (/\s/.test(value)) {
      setChromeOsHostError(t("emulatorHostAliasNoSpaces"));
      return;
    }

    const deduped = Array.from(new Set([...chromeOsHosts, value]));
    try {
      await updateSetting("chromeOsHosts", deduped);
      setHostInput("");
      setChromeOsHostError(null);
      await refresh();
    } catch (err) {
      setChromeOsHostError(
        err instanceof Error ? err.message : t("emulatorHostAliasSaveFailed"),
      );
    }
  };

  const removeHost = async (host: string) => {
    const next = chromeOsHosts.filter(
      (item) => item.toLowerCase() !== host.toLowerCase(),
    );
    try {
      await updateSetting("chromeOsHosts", next);
      setChromeOsHostError(null);
      await refresh();
    } catch (err) {
      setChromeOsHostError(
        err instanceof Error ? err.message : t("emulatorHostAliasRemoveFailed"),
      );
    }
  };

  const deviceBridgeEnabled = settings?.deviceBridgeEnabled ?? false;

  return (
    <section className="flex flex-col gap-8 mb-12">
      <h2
        style={{ fontFamily: "var(--font-display)" }}
        className="text-[2rem] text-[var(--text-primary)] mb-2"
      >
        {t("emulatorSectionTitle")}
      </h2>
      <p className="text-sm text-[var(--text-dimmed)]">
        {t("emulatorSectionDescription")}
      </p>

      <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
        <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
          <div className="flex flex-col gap-1">
            <strong>{t("emulatorEnableTitle")}</strong>
            <p>{t("emulatorEnableDescription")}</p>
          </div>
          <label className="relative inline-block h-6 w-11 shrink-0 cursor-pointer">
            <input
              type="checkbox"
              className="peer sr-only"
              checked={deviceBridgeEnabled}
              onChange={(e) => {
                void updateSetting("deviceBridgeEnabled", e.target.checked);
              }}
              disabled={settingsLoading}
            />
            <span className="absolute inset-0 rounded-full border border-[var(--border-color)] bg-[var(--bg-hover)] transition-all duration-200 peer-checked:border-[var(--accent-color,#3b82f6)] peer-checked:bg-[var(--accent-color,#3b82f6)]" />
            <span className="absolute bottom-[2px] left-[2px] h-[18px] w-[18px] rounded-full bg-[var(--text-muted)] transition-all duration-200 peer-checked:translate-x-5 peer-checked:bg-white" />
          </label>
        </div>
      </div>

      {!deviceBridgeEnabled ? null : (
        <>
          <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
            <h3>{t("emulatorStreamQualityTitle")}</h3>
            <p className="text-sm text-[var(--text-dimmed)]">
              {t("emulatorStreamQualityDescription")}
            </p>

            <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
              <div className="flex flex-col gap-1">
                <strong>{t("emulatorFrameRateTitle")}</strong>
                <p>{t("emulatorFrameRateDescription")}</p>
              </div>
              <div className="flex gap-0.5 bg-[var(--bg-surface)] border border-[var(--border-color)] rounded-[var(--radius-md)] p-0.5">
                {EMULATOR_FPS_OPTIONS.map((fps) => (
                  <button
                    key={fps}
                    type="button"
                    className={`px-[var(--space-2)] py-[var(--space-1)] bg-transparent border-none rounded-[var(--radius-sm)] text-[var(--text-muted)] text-sm cursor-pointer transition-colors duration-150 whitespace-nowrap hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ${maxFps === fps ? "bg-[var(--text-primary)] text-white" : ""}`}
                    onClick={() => setMaxFps(fps)}
                  >
                    {fps} fps
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
              <div className="flex flex-col gap-1">
                <strong>{t("emulatorResolutionTitle")}</strong>
                <p>{t("emulatorResolutionDescription")}</p>
              </div>
              <div className="flex gap-0.5 bg-[var(--bg-surface)] border border-[var(--border-color)] rounded-[var(--radius-md)] p-0.5">
                {EMULATOR_WIDTH_OPTIONS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    className={`px-[var(--space-2)] py-[var(--space-1)] bg-transparent border-none rounded-[var(--radius-sm)] text-[var(--text-muted)] text-sm cursor-pointer transition-colors duration-150 whitespace-nowrap hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ${maxWidth === w ? "bg-[var(--text-primary)] text-white" : ""}`}
                    onClick={() => setMaxWidth(w)}
                  >
                    {w}p
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
              <div className="flex flex-col gap-1">
                <strong>{t("emulatorQualityTitle")}</strong>
                <p>{t("emulatorQualityDescription")}</p>
              </div>
              <div className="flex gap-0.5 bg-[var(--bg-surface)] border border-[var(--border-color)] rounded-[var(--radius-md)] p-0.5">
                {QUALITY_OPTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    className={`px-[var(--space-2)] py-[var(--space-1)] bg-transparent border-none rounded-[var(--radius-sm)] text-[var(--text-muted)] text-sm cursor-pointer transition-colors duration-150 whitespace-nowrap hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ${quality === q ? "bg-[var(--text-primary)] text-white" : ""}`}
                    onClick={() => setQuality(q)}
                  >
                    {getQualityLabel(q)}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
              <div className="flex flex-col gap-1">
                <strong>{t("emulatorAdaptiveFpsTitle")}</strong>
                <p>{t("emulatorAdaptiveFpsDescription")}</p>
              </div>
              <label className="relative inline-block h-6 w-11 shrink-0 cursor-pointer">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={adaptiveFps}
                  onChange={(e) => setAdaptiveFps(e.target.checked)}
                />
                <span className="absolute inset-0 rounded-full border border-[var(--border-color)] bg-[var(--bg-hover)] transition-all duration-200 peer-checked:border-[var(--accent-color,#3b82f6)] peer-checked:bg-[var(--accent-color,#3b82f6)]" />
                <span className="absolute bottom-[2px] left-[2px] h-[18px] w-[18px] rounded-full bg-[var(--text-muted)] transition-all duration-200 peer-checked:translate-x-5 peer-checked:bg-white" />
              </label>
            </div>
          </div>

          <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
            <h3>{t("emulatorChromeOsHostsTitle")}</h3>
            <p className="text-sm text-[var(--text-dimmed)]">
              {t("emulatorChromeOsHostsDescription")}
              <code> chromeroot</code>
              {t("emulatorChromeOsHostsDescriptionSuffix")}
            </p>

            <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
              <div className="flex flex-col gap-1">
                <strong>{t("emulatorAddHostAliasTitle")}</strong>
                <p>{t("emulatorAddHostAliasDescription")}</p>
              </div>
              <form
                className="flex items-center gap-[var(--space-2)] shrink-0"
                onSubmit={(event) => {
                  event.preventDefault();
                  void addHost();
                }}
              >
                <input
                  type="text"
                  name="chromeosHost"
                  placeholder={t("emulatorHostAliasPlaceholder")}
                  className="px-3 py-2 rounded-md border border-[var(--border-input)] bg-[var(--bg-input)] text-sm text-[var(--text-primary)] cursor-pointer"
                  autoComplete="off"
                  value={hostInput}
                  onChange={(event) => setHostInput(event.target.value)}
                />
                <button
                  type="submit"
                  className="px-3 py-1.5 rounded-md border border-[var(--border-color)] bg-transparent text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
                  disabled={settingsLoading}
                >
                  {t("projectsAddConfirm")}
                </button>
              </form>
            </div>

            {chromeOsHostError && (
              <p className="text-xs text-[var(--error-color)] mt-1">
                {chromeOsHostError}
              </p>
            )}
            {settingsError && (
              <p className="text-xs text-[var(--error-color)] mt-1">
                {settingsError}
              </p>
            )}

            {chromeOsHosts.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">
                {t("emulatorNoChromeOsHosts")}
              </p>
            ) : (
              chromeOsHosts.map((host) => (
                <div
                  key={host}
                  className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]"
                >
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {host}
                    </span>
                    <span className="text-sm text-[var(--text-muted)]">
                      Device ID: chromeos:{host}
                    </span>
                  </div>
                  <div className="shrink-0">
                    <button
                      type="button"
                      className="px-3 py-1.5 rounded-md border border-[var(--border-color)] bg-transparent text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
                      onClick={() => {
                        void removeHost(host);
                      }}
                      disabled={settingsLoading}
                    >
                      {t("emulatorRemove")}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
            <h3>{t("emulatorDiscoveredDevicesTitle")}</h3>

            {loading && (
              <p className="text-sm text-[var(--text-muted)]">
                {t("projectsLoading")}
              </p>
            )}
            {error && (
              <p className="text-xs text-[var(--error-color)] mt-1">{error}</p>
            )}

            {!loading && emulators.length === 0 && (
              <p className="text-sm text-[var(--text-muted)]">
                {t("emulatorNoDevicesFound")}
              </p>
            )}

            {emulators.map((device) => (
              <div
                key={device.id}
                className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]"
              >
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium text-[var(--text-primary)]">
                    {device.label || device.avd || device.id}
                  </span>
                  <span className="text-sm text-[var(--text-muted)]">
                    {device.type} - {device.id} - {device.state}
                  </span>
                </div>
                <div className="shrink-0">
                  {canStopDevice(device.type, device.state, device.actions) ? (
                    <button
                      type="button"
                      className="px-3 py-1.5 rounded-md border border-[var(--border-color)] bg-transparent text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
                      onClick={() => stopEmulator(device.id)}
                    >
                      {t("emulatorStop")}
                    </button>
                  ) : canStartDevice(
                      device.type,
                      device.state,
                      device.actions,
                    ) ? (
                    <button
                      type="button"
                      className="px-3 py-1.5 rounded-md border border-[var(--border-color)] bg-transparent text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
                      onClick={() => startEmulator(device.id)}
                    >
                      {t("emulatorStart")}
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
