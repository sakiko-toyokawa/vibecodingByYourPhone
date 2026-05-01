import { useCallback, useEffect, useState } from "react";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";

const MAX_URL_LENGTH = 2000;
const MAX_TOKEN_LENGTH = 5000;

export function LifecycleWebhooksSettings() {
  const { t } = useI18n();
  const { settings, isLoading, error, updateSetting } = useServerSettings();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    setUrl(settings.lifecycleWebhookUrl ?? "");
    setToken(settings.lifecycleWebhookToken ?? "");
  }, [settings]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await Promise.all([
        updateSetting("lifecycleWebhookUrl", url.trim() || undefined),
        updateSetting("lifecycleWebhookToken", token.trim() || undefined),
      ]);
      setHasChanges(false);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : t("lifecycleWebhooksSaveFailed"),
      );
    } finally {
      setIsSaving(false);
    }
  }, [t, token, updateSetting, url]);

  if (isLoading) {
    return (
      <section className="flex flex-col gap-8 mb-12">
        <h2
          style={{ fontFamily: "var(--font-display)" }}
          className="text-[2rem] text-[var(--text-primary)] mb-2"
        >
          {t("lifecycleWebhooksTitle")}
        </h2>
        <p className="mb-[var(--space-3)] text-sm text-[var(--text-muted)]">
          {t("lifecycleWebhooksLoading")}
        </p>
      </section>
    );
  }

  const serverUrl = settings?.lifecycleWebhookUrl ?? "";
  const serverToken = settings?.lifecycleWebhookToken ?? "";
  const enabled = settings?.lifecycleWebhooksEnabled ?? false;
  const dryRun = settings?.lifecycleWebhookDryRun ?? true;

  return (
    <section className="flex flex-col gap-8 mb-12">
      <h2
        style={{ fontFamily: "var(--font-display)" }}
        className="text-[2rem] text-[var(--text-primary)] mb-2"
      >
        {t("lifecycleWebhooksTitle")}
      </h2>
      <p className="mb-[var(--space-3)] text-sm text-[var(--text-muted)]">
        {t("lifecycleWebhooksDescription")}
      </p>

      <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
        <label className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
          <div className="flex flex-col gap-1">
            <strong>{t("lifecycleWebhooksEnableTitle")}</strong>
            <p>{t("lifecycleWebhooksEnableDescription")}</p>
          </div>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) =>
              void updateSetting("lifecycleWebhooksEnabled", e.target.checked)
            }
          />
        </label>

        <div
          className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]"
          style={{ flexDirection: "column", alignItems: "stretch" }}
        >
          <div className="flex flex-col gap-1">
            <strong>{t("lifecycleWebhooksUrlTitle")}</strong>
            <p>{t("lifecycleWebhooksUrlDescription")}</p>
          </div>
          <input
            type="url"
            className="px-3 py-2 rounded-md border border-[var(--border-input)] bg-[var(--bg-input)] text-sm text-[var(--text-primary)] outline-none focus:border-[var(--focus-border)]"
            value={url}
            onChange={(e) => {
              const value = e.target.value.slice(0, MAX_URL_LENGTH);
              setUrl(value);
              setHasChanges(value !== serverUrl || token !== serverToken);
              setSaveError(null);
            }}
            placeholder="https://example.com/hooks/yep"
          />
        </div>

        <div
          className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]"
          style={{ flexDirection: "column", alignItems: "stretch" }}
        >
          <div className="flex flex-col gap-1">
            <strong>{t("lifecycleWebhooksTokenTitle")}</strong>
            <p>{t("lifecycleWebhooksTokenDescription")}</p>
          </div>
          <input
            type="password"
            className="px-3 py-2 rounded-md border border-[var(--border-input)] bg-[var(--bg-input)] text-sm text-[var(--text-primary)] outline-none focus:border-[var(--focus-border)]"
            value={token}
            onChange={(e) => {
              const value = e.target.value.slice(0, MAX_TOKEN_LENGTH);
              setToken(value);
              setHasChanges(url !== serverUrl || value !== serverToken);
              setSaveError(null);
            }}
            placeholder={t("lifecycleWebhooksTokenPlaceholder")}
          />
        </div>

        <label className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
          <div className="flex flex-col gap-1">
            <strong>{t("lifecycleWebhooksDryRunTitle")}</strong>
            <p>{t("lifecycleWebhooksDryRunDescription")}</p>
          </div>
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(e) =>
              void updateSetting("lifecycleWebhookDryRun", e.target.checked)
            }
          />
        </label>

        <div
          className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]"
          style={{ justifyContent: "flex-end", gap: "var(--space-2)" }}
        >
          <button
            type="button"
            className="px-3 py-1.5 rounded-md border border-[var(--border-color)] bg-transparent text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
            disabled={!hasChanges || isSaving}
            onClick={handleSave}
          >
            {isSaving ? t("providersSaving") : t("providersSave")}
          </button>
        </div>

        {(saveError || error) && (
          <p className="text-xs text-[var(--warning-color)] mt-1">
            {saveError || error}
          </p>
        )}
      </div>
    </section>
  );
}
