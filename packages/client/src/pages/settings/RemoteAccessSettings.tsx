import { useNavigate } from "react-router-dom";
import { RemoteAccessSetup } from "../../components/RemoteAccessSetup";
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
        <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
          <div className="flex flex-col gap-1">
            <strong>{t("developmentPersistRemoteTitle")}</strong>
            <p>
              {t("developmentPersistRemoteDescriptionPrefix")}{" "}
              <code>remote-sessions.json</code> so relay reconnect survives
              {t("developmentPersistRemoteDescriptionSuffix")}
            </p>
          </div>
          <label className="relative inline-block h-6 w-11 shrink-0 cursor-pointer">
            <input
              type="checkbox"
              className="peer sr-only"
              checked={settings?.persistRemoteSessionsToDisk ?? false}
              disabled={isLoading}
              onChange={(e) =>
                void updateSetting(
                  "persistRemoteSessionsToDisk",
                  e.target.checked,
                )
              }
            />
            <span className="absolute inset-0 rounded-full border border-[var(--border-color)] bg-[var(--bg-hover)] transition-all duration-200 peer-checked:border-[var(--accent-color,#3b82f6)] peer-checked:bg-[var(--accent-color,#3b82f6)]" />
            <span className="absolute bottom-[2px] left-[2px] h-[18px] w-[18px] rounded-full bg-[var(--text-muted)] transition-all duration-200 peer-checked:translate-x-5 peer-checked:bg-white" />
          </label>
        </div>
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
          <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
            <div className="flex flex-col gap-1">
              <strong>{t("remoteAccessCurrentHostTitle")}</strong>
              <p>{displayName}</p>
            </div>
            <button
              type="button"
              className="px-3 py-1.5 rounded-md border border-[var(--border-color)] bg-transparent text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
              onClick={handleSwitchHost}
            >
              {t("sidebarSwitchHost")}
            </button>
          </div>
          <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
            <div className="flex flex-col gap-1">
              <strong>{t("remoteAccessLogoutTitle")}</strong>
              <p>{t("remoteAccessLogoutDescription")}</p>
            </div>
            <button
              type="button"
              className="px-[var(--space-3)] py-[var(--space-2)] rounded-[var(--radius-sm)] text-sm cursor-pointer transition-colors duration-150 whitespace-nowrap border bg-[var(--error-color)] border-[var(--error-color)] text-white hover:bg-[var(--error-hover,#b91c1c)] hover:border-[var(--error-hover,#b91c1c)] disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => remoteConnection.disconnect()}
            >
              {t("remoteAccessLogout")}
            </button>
          </div>
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
