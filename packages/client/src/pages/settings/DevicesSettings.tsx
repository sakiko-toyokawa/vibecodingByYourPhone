import { useBrowserProfiles } from "../../hooks/useBrowserProfiles";
import { useConnectedDevices } from "../../hooks/useConnectedDevices";
import { usePushNotifications } from "../../hooks/usePushNotifications";
import { useI18n } from "../../i18n";
import { parseUserAgent } from "../../lib/deviceDetection";

/**
 * Format a date for display with relative time.
 */
function formatDate(
  isoDate: string,
  t: (key: never, vars?: Record<string, string | number>) => string,
): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMinutes < 1) {
    return t("devicesJustNow" as never);
  }
  if (diffMinutes < 60) {
    return t("devicesMinutesAgo" as never, {
      count: diffMinutes,
      suffix: diffMinutes === 1 ? "" : "s",
    });
  }
  if (diffHours < 24) {
    return t("devicesHoursAgo" as never, {
      count: diffHours,
      suffix: diffHours === 1 ? "" : "s",
    });
  }
  if (diffDays === 1) {
    return t("devicesYesterday" as never);
  }
  if (diffDays < 7) {
    return `${diffDays} days ago`;
  }
  return date.toLocaleDateString();
}

/**
 * Format an origin URL for display.
 * Shows a simplified version with just scheme://hostname:port
 */
function formatOrigin(origin: string): string {
  return origin;
}

/**
 * Devices settings page.
 * Shows all browser profiles with their connection origin history.
 */
export function DevicesSettings() {
  const { t } = useI18n();
  const { profiles, isLoading, error, deleteProfile } = useBrowserProfiles();
  const { browserProfileId: currentBrowserProfileId } = usePushNotifications();
  const { connections } = useConnectedDevices();

  return (
    <>
      <section className="flex flex-col gap-8 mb-12">
        <h2
          style={{ fontFamily: "var(--font-display)" }}
          className="text-[2rem] text-[var(--text-primary)] mb-2"
        >
          {t("devicesProfilesTitle")}
        </h2>
        <p className="mb-[var(--space-3)] text-sm text-[var(--text-muted)]">
          {t("devicesProfilesDescription")}
        </p>

        {error && (
          <p className="text-[var(--error-color)] [font-size:var(--font-size-sm)] p-[var(--space-2)] bg-[rgba(199,78,57,0.1)] rounded-[var(--radius-md)]">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
          {isLoading ? (
            <p className="text-[var(--text-muted)] [font-size:var(--font-size-sm)] p-[var(--space-2)]">
              {t("devicesLoadingProfiles")}
            </p>
          ) : profiles.length === 0 ? (
            <p className="text-[var(--text-muted)] [font-size:var(--font-size-sm)] p-[var(--space-2)]">
              {t("devicesEmpty")}
            </p>
          ) : (
            <div className="flex flex-col gap-[var(--space-2)]">
              {profiles.map((profile) => {
                const isCurrentDevice =
                  profile.browserProfileId === currentBrowserProfileId;
                const isConnected = connections.has(profile.browserProfileId);
                const displayName =
                  profile.deviceName ||
                  `${profile.browserProfileId.slice(0, 8)}...`;

                return (
                  <div
                    key={profile.browserProfileId}
                    className="flex items-center justify-between gap-[var(--space-3)] p-[var(--space-3)] bg-[var(--bg-elevated)] border border-[var(--border-muted)] rounded-[var(--radius-md)]"
                  >
                    <div className="flex-1 min-w-0">
                      <strong className="flex items-center gap-[var(--space-2)] [font-size:var(--font-size-base)]">
                        <span
                          className={`mr-[var(--space-2)] ${isConnected ? "before:content-[''] before:inline-block before:w-2 before:h-2 before:rounded-full before:bg-[var(--success-color)] before:mr-1 before:align-middle" : "before:content-[''] before:inline-block before:w-2 before:h-2 before:rounded-full before:bg-[var(--text-muted)] before:mr-1 before:align-middle"}`}
                          title={
                            isConnected
                              ? t("devicesConnected")
                              : t("devicesDisconnected")
                          }
                        />
                        {displayName}
                        {isCurrentDevice && (
                          <span className="[font-size:var(--font-size-xs)] font-medium px-[6px] py-[2px] bg-[var(--text-primary)] text-white rounded-[var(--radius-sm)]">
                            {t("devicesThisDevice")}
                          </span>
                        )}
                      </strong>

                      {/* Origin list */}
                      <div className="mt-[var(--space-1)]">
                        {profile.origins.map((origin) => {
                          const { browser, os } = parseUserAgent(
                            origin.userAgent,
                          );
                          return (
                            <div
                              key={origin.origin}
                              className="flex flex-col gap-[2px] mb-[var(--space-2)]"
                            >
                              <code className="[font-size:var(--font-size-sm)] break-all">
                                {formatOrigin(origin.origin)}
                              </code>
                              <span className="[font-size:var(--font-size-xs)] text-[var(--text-muted)]">
                                {browser} · {os}
                              </span>
                              <span className="[font-size:var(--font-size-xs)] text-[var(--text-muted)]">
                                {t("devicesLastSeen", {
                                  date: formatDate(origin.lastSeen, t),
                                })}
                              </span>
                            </div>
                          );
                        })}
                      </div>

                      <p className="[font-size:var(--font-size-xs)] text-[var(--text-muted)] mt-[var(--space-1)]">
                        {t("devicesFirstSeen", {
                          date: formatDate(profile.createdAt, t),
                        })}
                      </p>
                    </div>

                    <button
                      type="button"
                      className="px-[var(--space-2)] py-[var(--space-2)] bg-transparent border border-[var(--error-color)] rounded-[var(--radius-sm)] text-[var(--error-color)] [font-size:var(--font-size-sm)] cursor-pointer transition-[background,color] duration-150 whitespace-nowrap hover:bg-[var(--error-color)] hover:text-white"
                      onClick={() => deleteProfile(profile.browserProfileId)}
                      title={t("devicesForgetThisDevice")}
                    >
                      {t("devicesForget")}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
