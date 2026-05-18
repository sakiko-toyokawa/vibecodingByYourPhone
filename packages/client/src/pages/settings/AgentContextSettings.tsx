import { useCallback, useEffect, useState } from "react";
import { SettingsTextarea } from "../../components/settings/SettingsFormControls";
import { SettingsRow } from "../../components/settings/SettingsRow";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";

const MAX_LENGTH = 10000;

export function AgentContextSettings() {
  const { t } = useI18n();
  const { settings, isLoading, error, updateSetting } = useServerSettings();
  const [instructions, setInstructions] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (settings) {
      setInstructions(settings.globalInstructions ?? "");
    }
  }, [settings]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await updateSetting(
        "globalInstructions",
        instructions.trim() || undefined,
      );
      setHasChanges(false);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : t("agentContextSaveFailed"),
      );
    } finally {
      setIsSaving(false);
    }
  }, [instructions, updateSetting, t]);

  if (isLoading) {
    return (
      <section className="flex flex-col gap-8 mb-12">
        <h2
          style={{ fontFamily: "var(--font-display)" }}
          className="text-[2rem] text-[var(--text-primary)] mb-2"
        >
          {t("agentContextTitle")}
        </h2>
        <p className="mb-[var(--space-3)] text-sm text-[var(--text-muted)]">
          {t("agentContextLoading")}
        </p>
      </section>
    );
  }

  const serverValue = settings?.globalInstructions ?? "";

  return (
    <section className="flex flex-col gap-8 mb-12">
      <h2
        style={{ fontFamily: "var(--font-display)" }}
        className="text-[2rem] text-[var(--text-primary)] mb-2"
      >
        {t("agentContextTitle")}
      </h2>
      <p className="mb-[var(--space-3)] text-sm text-[var(--text-muted)]">
        {t("agentContextDescription")}
      </p>

      <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
        <div
          className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]"
          style={{ flexDirection: "column", alignItems: "stretch" }}
        >
          <div className="flex flex-col gap-1">
            <strong>{t("agentContextGlobalInstructions")}</strong>
            <p>{t("agentContextGlobalInstructionsDescription")}</p>
          </div>
          <SettingsTextarea
            className="mt-[var(--space-3)] min-h-[220px] w-full"
            value={instructions}
            onChange={(e) => {
              const value = e.target.value.slice(0, MAX_LENGTH);
              setInstructions(value);
              setHasChanges(value !== serverValue);
              setSaveError(null);
            }}
            placeholder={t("agentContextPlaceholder")}
            rows={10}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: "var(--space-2)",
            }}
          >
            <span className="text-sm text-[var(--text-muted)]">
              {t("agentContextCharacters", {
                current: instructions.length.toLocaleString(),
                max: MAX_LENGTH.toLocaleString(),
              })}
            </span>
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
      </div>
    </section>
  );
}
