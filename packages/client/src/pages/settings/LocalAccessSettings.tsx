import { useState } from "react";
import { api } from "../../api/client";
import { FilterDropdown } from "../../components/FilterDropdown";
import {
  SettingsSwitch,
  SettingsTextInput,
} from "../../components/settings/SettingsFormControls";
import { SettingsRow } from "../../components/settings/SettingsRow";
import { useOptionalAuth } from "../../contexts/AuthContext";
import { useOptionalRemoteConnection } from "../../contexts/RemoteConnectionContext";
import { useDeveloperMode } from "../../hooks/useDeveloperMode";
import { useNetworkBinding } from "../../hooks/useNetworkBinding";
import { useServerInfo } from "../../hooks/useServerInfo";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";

export function LocalAccessSettings() {
  const { t } = useI18n();
  const auth = useOptionalAuth();
  const remoteConnection = useOptionalRemoteConnection();
  const { relayDebugEnabled, setRelayDebugEnabled } = useDeveloperMode();
  const { serverInfo, loading: serverInfoLoading } = useServerInfo();
  const {
    binding,
    loading: bindingLoading,
    error: bindingError,
    applying,
    updateBinding,
  } = useNetworkBinding();
  const { settings: serverSettings, isLoading: settingsLoading } =
    useServerSettings();

  // Network binding form state
  const [localhostPort, setLocalhostPort] = useState<string>("");
  const [networkEnabled, setNetworkEnabled] = useState(false);
  const [selectedInterface, setSelectedInterface] = useState<string>("");
  const [customIp, setCustomIp] = useState("");

  // Auth form state (merged into same form)
  const [requirePassword, setRequirePassword] = useState(false);
  const [localhostOpenToggle, setLocalhostOpenToggle] = useState(false);
  const [authPassword, setAuthPassword] = useState("");
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState("");

  // Allowed hosts form state
  const [allowAllHostsToggle, setAllowAllHostsToggle] = useState(false);
  const [allowedHostsText, setAllowedHostsText] = useState("");

  // Form state
  const [formError, setFormError] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [isApplying, setIsApplying] = useState(false);

  // Initialize form from binding, auth, and settings state when it loads
  const [formInitialized, setFormInitialized] = useState(false);
  if (binding && auth && serverSettings && !formInitialized) {
    setLocalhostPort(String(binding.localhost.port));
    setNetworkEnabled(binding.network.enabled);
    setSelectedInterface(binding.network.host ?? "");
    setRequirePassword(auth.authEnabled);
    setLocalhostOpenToggle(auth.localhostOpen);
    // Initialize allowed hosts from server settings
    const ah = serverSettings.allowedHosts;
    if (ah === "*") {
      setAllowAllHostsToggle(true);
      setAllowedHostsText("");
    } else {
      setAllowAllHostsToggle(false);
      setAllowedHostsText(ah ?? "");
    }
    setFormInitialized(true);
  }

  // Compute the effective allowedHosts value for comparison/saving
  const getAllowedHostsValue = (
    toggle: boolean,
    text: string,
  ): string | undefined => {
    if (toggle) return "*";
    const trimmed = text.trim();
    return trimmed || undefined;
  };

  // Track changes - includes auth and allowed hosts changes
  const checkForChanges = (
    newPort: string,
    newNetworkEnabled: boolean,
    newInterface: string,
    newRequirePassword: boolean,
    newPassword: string,
    newAllowAllHosts: boolean,
    newAllowedHostsText: string,
    newLocalhostOpen: boolean,
  ) => {
    if (!binding || !auth || !serverSettings) return false;
    const portChanged = newPort !== String(binding.localhost.port);
    const networkEnabledChanged = newNetworkEnabled !== binding.network.enabled;
    const interfaceChanged = newInterface !== (binding.network.host ?? "");
    const authChanged = newRequirePassword !== auth.authEnabled;
    const passwordEntered = newPassword.length > 0;
    const localhostOpenChanged = newLocalhostOpen !== auth.localhostOpen;
    const newValue = getAllowedHostsValue(
      newAllowAllHosts,
      newAllowedHostsText,
    );
    const oldValue = serverSettings.allowedHosts;
    const allowedHostsChanged = (newValue ?? "") !== (oldValue ?? "");
    return (
      portChanged ||
      networkEnabledChanged ||
      interfaceChanged ||
      authChanged ||
      passwordEntered ||
      localhostOpenChanged ||
      allowedHostsChanged
    );
  };

  // Helper for onChange handlers
  const updateHasChanges = (overrides: {
    port?: string;
    networkEnabled?: boolean;
    iface?: string;
    requirePw?: boolean;
    password?: string;
    allowAll?: boolean;
    hostsText?: string;
    localhostOpen?: boolean;
  }) => {
    setHasChanges(
      checkForChanges(
        overrides.port ?? localhostPort,
        overrides.networkEnabled ?? networkEnabled,
        overrides.iface ?? selectedInterface,
        overrides.requirePw ?? requirePassword,
        overrides.password ?? authPassword,
        overrides.allowAll ?? allowAllHostsToggle,
        overrides.hostsText ?? allowedHostsText,
        overrides.localhostOpen ?? localhostOpenToggle,
      ),
    );
  };

  const handleApplyChanges = async () => {
    if (!auth) return;
    setFormError(null);

    // Validate port
    const portNum = Number.parseInt(localhostPort, 10);
    if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setFormError(t("localAccessErrorPortRange"));
      return;
    }

    // Validate password if enabling or changing auth
    const enablingAuth = requirePassword && !auth.authEnabled;
    const changingPassword =
      requirePassword && auth.authEnabled && authPassword.length > 0;
    if (enablingAuth || changingPassword) {
      if (authPassword.length < 6) {
        setFormError(t("localAccessErrorPasswordLength"));
        return;
      }
      if (authPassword !== authPasswordConfirm) {
        setFormError(t("localAccessErrorPasswordMismatch"));
        return;
      }
    }

    const effectiveInterface =
      selectedInterface === "custom" ? customIp : selectedInterface;

    setIsApplying(true);
    try {
      // Apply network binding changes (skip overridden fields to avoid 400 errors)
      const bindingUpdate: Parameters<typeof updateBinding>[0] = {};
      if (!binding?.localhost.overriddenByCli) {
        bindingUpdate.localhostPort = portNum;
      }
      if (!binding?.network.overriddenByCli) {
        bindingUpdate.network = {
          enabled: networkEnabled,
          host: networkEnabled ? effectiveInterface : undefined,
        };
      }
      const result = await updateBinding(bindingUpdate);

      // Apply auth changes
      if (enablingAuth) {
        await auth.enableAuth(authPassword);
        setAuthPassword("");
        setAuthPasswordConfirm("");
      } else if (changingPassword) {
        await auth.changePassword(authPassword);
        setAuthPassword("");
        setAuthPasswordConfirm("");
      } else if (!requirePassword && auth.authEnabled) {
        await auth.disableAuth();
      }

      // Apply localhost access changes (desktop token floor bypass)
      if (localhostOpenToggle !== auth.localhostOpen) {
        await auth.setLocalhostOpen(localhostOpenToggle);
      }

      // Apply allowed hosts changes
      const newAllowedHosts = getAllowedHostsValue(
        allowAllHostsToggle,
        allowedHostsText,
      );
      await api.updateServerSettings({
        allowedHosts: newAllowedHosts ?? "",
      });

      if (result.redirectUrl) {
        if (typeof window !== "undefined" && window.__YEP_SERVER_URL__) {
          // Desktop mode: port change requires app restart, just clear changes
          setHasChanges(false);
        } else {
          // Browser mode: redirect to new URL preserving current path
          const newUrl = new URL(result.redirectUrl);
          newUrl.pathname = window.location.pathname;
          newUrl.search = window.location.search;
          window.location.href = newUrl.toString();
        }
      } else {
        setHasChanges(false);
      }
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : t("localAccessErrorApplyFailed"),
      );
    } finally {
      setIsApplying(false);
    }
  };

  // Non-remote mode (cookie-based auth)
  if (auth) {
    // Show loading state until data is ready
    const isLoading =
      serverInfoLoading ||
      bindingLoading ||
      settingsLoading ||
      auth.isLoading ||
      !formInitialized;

    if (isLoading) {
      return (
        <section className="flex flex-col gap-8 mb-12">
          <h2
            style={{ fontFamily: "var(--font-display)" }}
            className="text-[2rem] text-[var(--text-primary)] mb-2"
          >
            {t("settingsLocalAccessTitle")}
          </h2>
          <p className="mb-[var(--space-3)] text-sm text-[var(--text-muted)]">
            {t("localAccessLoading")}
          </p>
        </section>
      );
    }

    // Show password fields when auth is enabled or being enabled
    const showPasswordFields = requirePassword;

    return (
      <section className="flex flex-col gap-8 mb-12">
        <h2
          style={{ fontFamily: "var(--font-display)" }}
          className="text-[2rem] text-[var(--text-primary)] mb-2"
        >
          {t("settingsLocalAccessTitle")}
        </h2>
        <p className="mb-[var(--space-3)] text-sm text-[var(--text-muted)]">
          {t("localAccessDescription")}
        </p>

        {/* Current status */}
        <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
          <SettingsRow
            title={t("localAccessStatusTitle")}
            description={
              serverInfo
                ? (() => {
                    const networkHost = binding?.network.host;
                    const networkPort =
                      binding?.network.port ?? serverInfo.port;
                    const isAllInterfaces =
                      networkHost === "0.0.0.0" || networkHost === "::";
                    const samePort = networkPort === serverInfo.port;

                    if (
                      binding?.network.enabled &&
                      isAllInterfaces &&
                      samePort
                    ) {
                      return (
                        <>
                          {t("localAccessListeningOn")}{" "}
                          <code>
                            {networkHost}:{networkPort}
                          </code>
                        </>
                      );
                    }

                    return (
                      <>
                        {t("localAccessListeningOn")}{" "}
                        <code>
                          {serverInfo.host}:{serverInfo.port}
                        </code>
                        {binding?.network.enabled && networkHost && (
                          <>
                            {" "}
                            {t("localAccessListeningAnd")}{" "}
                            <code>
                              {networkHost}:{networkPort}
                            </code>
                          </>
                        )}
                      </>
                    );
                  })()
                : t("localAccessUnableToFetch")
            }
          >
            {serverInfo?.localhostOnly && !binding?.network.enabled && (
              <span className="px-[var(--space-1)] py-[var(--space-2)] rounded-[var(--radius-sm)] text-sm font-medium bg-[var(--bg-hover)] text-[var(--text-secondary)]">
                {t("localAccessBadgeLocalOnly")}
              </span>
            )}
            {(serverInfo?.boundToAllInterfaces || binding?.network.enabled) &&
              !auth.authEnabled && (
                <span className="px-[var(--space-1)] py-[var(--space-2)] rounded-[var(--radius-sm)] text-sm font-medium bg-[var(--warning-badge-bg)] text-white">
                  {t("localAccessBadgeNetworkExposed")}
                </span>
              )}
          </SettingsRow>
        </div>

        {/* Network Configuration */}
        <form
          className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]"
          onSubmit={(e) => {
            e.preventDefault();
            handleApplyChanges();
          }}
        >
          <SettingsRow
            title={t("localAccessListeningPortTitle")}
            description={t("localAccessListeningPortDescription")}
          >
            {binding?.localhost.overriddenByCli ? (
              <span className="text-sm text-[var(--text-primary)]">
                {binding.localhost.port}{" "}
                <span className="text-sm text-[var(--text-muted)]">
                  {t("localAccessSetViaPort")}
                </span>
              </span>
            ) : (
              <SettingsTextInput
                type="number"
                className="w-24"
                value={localhostPort}
                onChange={(e) => {
                  setLocalhostPort(e.target.value);
                  updateHasChanges({ port: e.target.value });
                }}
                min={1}
                max={65535}
                autoComplete="off"
              />
            )}
          </SettingsRow>

          <SettingsRow
            title={t("localAccessNetworkTitle")}
            description={t("localAccessNetworkDescription")}
          >
            {binding?.network.overriddenByCli ? (
              <span className="text-sm text-[var(--text-primary)]">
                {binding.network.host}:{binding.network.port}{" "}
                <span className="text-sm text-[var(--text-muted)]">
                  {t("localAccessSetViaHost")}
                </span>
              </span>
            ) : (
              <SettingsSwitch
                checked={networkEnabled}
                onChange={(checked) => {
                  setNetworkEnabled(checked);
                  updateHasChanges({ networkEnabled: checked });
                }}
                ariaLabel={t("localAccessNetworkTitle")}
              />
            )}
          </SettingsRow>

          {networkEnabled && !binding?.network.overriddenByCli && binding && (
            <SettingsRow
              title={t("localAccessInterfaceTitle")}
              description={t("localAccessInterfaceDescription")}
            >
              <FilterDropdown
                label={t("localAccessInterfaceTitle")}
                placeholder={t("localAccessInterfacePlaceholder")}
                multiSelect={false}
                align="right"
                options={[
                  ...binding.interfaces.map((iface) => ({
                    value: iface.address,
                    label: iface.displayName,
                  })),
                  {
                    value: "0.0.0.0",
                    label: t("localAccessInterfaceAll"),
                  },
                  { value: "custom", label: t("localAccessInterfaceCustom") },
                ]}
                selected={selectedInterface ? [selectedInterface] : []}
                onChange={(values) => {
                  const newInterface = values[0] ?? "";
                  setSelectedInterface(newInterface);
                  updateHasChanges({ iface: newInterface });
                }}
              />
            </SettingsRow>
          )}

          {networkEnabled &&
            !binding?.network.overriddenByCli &&
            selectedInterface === "custom" && (
              <SettingsRow
                title={t("localAccessCustomIpTitle")}
                description={t("localAccessCustomIpDescription")}
              >
                <SettingsTextInput
                  type="text"
                  placeholder="192.168.1.100"
                  value={customIp}
                  onChange={(e) => setCustomIp(e.target.value)}
                />
              </SettingsRow>
            )}

          {/* Allowed Hosts — applies even on localhost (reverse proxy may use different hostname) */}
          <SettingsRow
            title={t("localAccessAllowAllHostsTitle")}
            description={t("localAccessAllowAllHostsDescription")}
          >
            <SettingsSwitch
              checked={allowAllHostsToggle}
              onChange={(checked) => {
                setAllowAllHostsToggle(checked);
                updateHasChanges({ allowAll: checked });
              }}
              ariaLabel={t("localAccessAllowAllHostsTitle")}
            />
          </SettingsRow>
          {!allowAllHostsToggle && (
            <SettingsRow
              title={t("localAccessAllowedHostsTitle")}
              description={t("localAccessAllowedHostsDescription")}
            >
              <SettingsTextInput
                type="text"
                className="min-w-[260px]"
                placeholder={t("localAccessAllowedHostsPlaceholder")}
                value={allowedHostsText}
                onChange={(e) => {
                  setAllowedHostsText(e.target.value);
                  updateHasChanges({ hostsText: e.target.value });
                }}
              />
            </SettingsRow>
          )}
          <p className="text-xs text-[var(--text-muted)] mt-1">
            {t("localAccessAllowedHostsHint")}
          </p>

          {/* Require Password toggle */}
          {!auth.authDisabledByEnv && (
            <SettingsRow
              title={t("localAccessRequirePasswordTitle")}
              description={t("localAccessRequirePasswordDescription")}
            >
              <SettingsSwitch
                checked={requirePassword}
                onChange={(checked) => {
                  setRequirePassword(checked);
                  updateHasChanges({ requirePw: checked });
                }}
                ariaLabel={t("localAccessRequirePasswordTitle")}
              />
            </SettingsRow>
          )}

          {/* Password fields - shown when auth is on */}
          {showPasswordFields && (
            <>
              {/* Hidden username field to prevent Chrome from using port as username */}
              <input
                type="text"
                name="username"
                autoComplete="username"
                style={{
                  position: "absolute",
                  visibility: "hidden",
                  pointerEvents: "none",
                }}
                tabIndex={-1}
              />
              <SettingsRow
                title={t("localAccessPasswordTitle")}
                description={
                  auth.authEnabled
                    ? t("localAccessPasswordKeepCurrent")
                    : t("localAccessPasswordMinLength")
                }
              >
                <SettingsTextInput
                  type="password"
                  className="min-w-[220px]"
                  value={authPassword}
                  onChange={(e) => {
                    setAuthPassword(e.target.value);
                    updateHasChanges({ password: e.target.value });
                  }}
                  autoComplete="new-password"
                  placeholder={
                    auth.authEnabled
                      ? t("localAccessPasswordNewPlaceholder")
                      : t("localAccessPasswordPlaceholder")
                  }
                />
              </SettingsRow>
              {authPassword.length > 0 && (
                <SettingsRow title={t("localAccessConfirmPasswordTitle")}>
                  <SettingsTextInput
                    type="password"
                    className="min-w-[220px]"
                    value={authPasswordConfirm}
                    onChange={(e) => setAuthPasswordConfirm(e.target.value)}
                    autoComplete="new-password"
                    placeholder={t("localAccessConfirmPasswordPlaceholder")}
                  />
                </SettingsRow>
              )}
              {!auth.authEnabled && (
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  {t("localAccessPasswordResetHint")}
                </p>
              )}
            </>
          )}

          {/* Allow Localhost Access - shown in desktop mode when password auth is off */}
          {auth.hasDesktopToken &&
            !requirePassword &&
            !auth.authDisabledByEnv && (
              <SettingsRow
                title={t("localAccessLocalhostOpenTitle")}
                description={t("localAccessLocalhostOpenDescription")}
              >
                <SettingsSwitch
                  checked={localhostOpenToggle}
                  onChange={(checked) => {
                    setLocalhostOpenToggle(checked);
                    updateHasChanges({ localhostOpen: checked });
                  }}
                  ariaLabel={t("localAccessLocalhostOpenTitle")}
                />
              </SettingsRow>
            )}

          {auth.authDisabledByEnv && (
            <p className="text-[var(--warning-color,#f59e0b)] text-sm p-[var(--space-2)] bg-[color-mix(in_srgb,var(--warning-color,#f59e0b)_10%,transparent)] rounded-[var(--radius-md)]">
              {t("localAccessAuthDisabled")}
            </p>
          )}

          {/* Apply button - always visible */}
          <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
            {formError && (
              <p className="text-[var(--error-color)] text-sm p-[var(--space-2)] bg-[var(--bg-error)] rounded-[var(--radius-md)]">
                {formError}
              </p>
            )}
            <button
              type="submit"
              className="px-3 py-1.5 rounded-md border border-[var(--border-color)] bg-transparent text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
              disabled={!hasChanges || isApplying || applying}
            >
              {isApplying || applying
                ? t("localAccessApplying")
                : t("localAccessApply")}
            </button>
          </div>
        </form>

        {/* Logout - shown when auth is enabled */}
        {auth.authEnabled && auth.isAuthenticated && (
          <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
            <SettingsRow
              title={t("remoteAccessLogoutTitle")}
              description={t("localAccessLogoutDescription")}
            >
              <button
                type="button"
                className="px-[var(--space-3)] py-[var(--space-2)] rounded-[var(--radius-sm)] text-sm cursor-pointer transition-colors duration-150 whitespace-nowrap border bg-[var(--error-color)] border-[var(--error-color)] text-white hover:bg-[var(--error-hover,#b91c1c)] hover:border-[var(--error-hover,#b91c1c)] disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={auth.logout}
              >
                {t("remoteAccessLogout")}
              </button>
            </SettingsRow>
          </div>
        )}
      </section>
    );
  }

  // Remote mode (SRP auth)
  if (remoteConnection) {
    return (
      <section className="flex flex-col gap-8 mb-12">
        <h2
          style={{ fontFamily: "var(--font-display)" }}
          className="text-[2rem] text-[var(--text-primary)] mb-2"
        >
          {t("settingsLocalAccessTitle")}
        </h2>
        <p className="mb-[var(--space-3)] text-sm text-[var(--text-muted)]">
          {t("localAccessRemoteDescription")}
        </p>
        <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
          <SettingsRow
            title={t("remoteAccessLogoutTitle")}
            description={t("localAccessRemoteLogoutDescription")}
          >
            <button
              type="button"
              className="px-[var(--space-3)] py-[var(--space-2)] rounded-[var(--radius-sm)] text-sm cursor-pointer transition-colors duration-150 whitespace-nowrap border bg-[var(--error-color)] border-[var(--error-color)] text-white hover:bg-[var(--error-hover,#b91c1c)] hover:border-[var(--error-hover,#b91c1c)] disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => remoteConnection.disconnect()}
            >
              {t("remoteAccessLogout")}
            </button>
          </SettingsRow>
          <SettingsRow
            title={t("localAccessRelayDebugTitle")}
            description={t("localAccessRelayDebugDescription")}
          >
            <SettingsSwitch
              checked={relayDebugEnabled}
              onChange={setRelayDebugEnabled}
              ariaLabel={t("localAccessRelayDebugTitle")}
            />
          </SettingsRow>
        </div>
      </section>
    );
  }

  // No auth context available
  return null;
}
