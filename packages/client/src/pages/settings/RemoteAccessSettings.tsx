import { useNavigate } from "react-router-dom";
import { RemoteAccessSetup } from "../../components/RemoteAccessSetup";
import { SettingsSwitch } from "../../components/settings/SettingsFormControls";
import { SettingsRow } from "../../components/settings/SettingsRow";
import { useOptionalRemoteConnection } from "../../contexts/RemoteConnectionContext";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";
import { getHostById } from "../../lib/hostStorage";

export function RemoteAccessSettings() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const remoteConnection = useOptionalRemoteConnection();
  const { settings, isLoading, error, updateSetting } = useServerSettings();

  // Handle switching hosts - disconnect and go to host picker
  const handleSwitchHost = () => {
    remoteConnection?.disconnect();
    navigate("/login");
  };

  const persistSessionsToggle = (
    <>
      <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
        <SettingsRow
          title={t("developmentPersistRemoteTitle")}
          description={
            <>
              {t("developmentPersistRemoteDescriptionPrefix")}{" "}
              <code>remote-sessions.json</code> so relay reconnect survives
              {t("developmentPersistRemoteDescriptionSuffix")}
            </>
          }
        >
          <SettingsSwitch
            checked={settings?.persistRemoteSessionsToDisk ?? false}
            disabled={isLoading}
            onChange={(checked) =>
              void updateSetting("persistRemoteSessionsToDisk", checked)
            }
            ariaLabel={t("developmentPersistRemoteTitle")}
          />
        </SettingsRow>
      </div>

      {error && (
        <p className="text-xs text-[var(--warning-color)] mt-1">{error}</p>
      )}
    </>
  );

  // When connected via relay, show connection info and logout
  if (remoteConnection) {
    // Get current host display name from hostStorage
    const currentHost = remoteConnection.currentHostId
      ? getHostById(remoteConnection.currentHostId)
      : null;
    const displayName =
      currentHost?.displayName ||
      remoteConnection.storedUsername ||
      t("remoteAccessDefaultHost");

    return (
      <section className="flex flex-col gap-8 mb-12">
        <h2
          style={{ fontFamily: "var(--font-display)" }}
          className="text-[2rem] text-[var(--text-primary)] mb-2"
        >
          {t("remoteAccessConnectedTitle")}
        </h2>
        <p className="mb-[var(--space-3)] text-sm text-[var(--text-muted)]">
          {t("remoteAccessConnectedDescription")}
        </p>
        <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
          <SettingsRow
            title={t("remoteAccessCurrentHostTitle")}
            description={displayName}
          >
            <button
              type="button"
              className="px-3 py-1.5 rounded-md border border-[var(--border-color)] bg-transparent text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
              onClick={handleSwitchHost}
            >
              {t("sidebarSwitchHost")}
            </button>
          </SettingsRow>
          <SettingsRow
            title={t("remoteAccessLogoutTitle")}
            description={t("remoteAccessLogoutDescription")}
          >
            <button
              type="button"
              className="px-[var(--space-3)] py-[var(--space-2)] rounded-[var(--radius-sm)] text-sm cursor-pointer transition-colors duration-150 whitespace-nowrap border bg-[var(--error-color)] border-[var(--error-color)] text-white hover:bg-[var(--error-hover,#b91c1c)] hover:border-[var(--error-hover,#b91c1c)] disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => remoteConnection.disconnect()}
            >
              {t("remoteAccessLogout")}
            </button>
          </SettingsRow>
        </div>
        {persistSessionsToggle}
      </section>
    );
  }

  // Server-side: show relay configuration
  return (
    <section className="flex flex-col gap-8 mb-12">
      <RemoteAccessSetup
        title={t("remoteAccessConnectedTitle")}
        description={t("remoteAccessSetupDescription")}
      />
      {persistSessionsToggle}
    </section>
  );
}
