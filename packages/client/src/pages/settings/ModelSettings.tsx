import { SettingsRow } from "../../components/settings/SettingsRow";
import {
  EFFORT_LEVEL_OPTIONS,
  MODEL_OPTIONS,
  useModelSettings,
} from "../../hooks/useModelSettings";
import { useI18n } from "../../i18n";

export function ModelSettings() {
  const { t } = useI18n();
  const { model, setModel, effortLevel, setEffortLevel } = useModelSettings();

  return (
    <section className="flex flex-col gap-8 mb-12">
      <h2
        style={{ fontFamily: "var(--font-display)" }}
        className="text-[2rem] text-[var(--text-primary)] mb-2"
      >
        {t("modelSettingsTitle")}
      </h2>
      <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
        <SettingsRow
          title={t("modelSettingsModelTitle")}
          description={t("modelSettingsModelDescription")}
        >
          <div className="flex gap-[2px] bg-[var(--bg-surface)] border border-[var(--border-color)] rounded-[var(--radius-md)] p-[2px]">
            {MODEL_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`px-[var(--space-2)] py-[var(--space-1)] bg-transparent border-none rounded-[var(--radius-sm)] text-[var(--text-muted)] [font-size:var(--font-size-sm)] cursor-pointer transition-[background,color] duration-150 whitespace-nowrap hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ${model === opt.value ? "bg-[var(--text-primary)] text-white" : ""}`}
                onClick={() => setModel(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow
          title={t("modelSettingsEffortTitle")}
          description={t("modelSettingsEffortDescription")}
        >
          <div className="flex gap-[2px] bg-[var(--bg-surface)] border border-[var(--border-color)] rounded-[var(--radius-md)] p-[2px]">
            {EFFORT_LEVEL_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`px-[var(--space-2)] py-[var(--space-1)] bg-transparent border-none rounded-[var(--radius-sm)] text-[var(--text-muted)] [font-size:var(--font-size-sm)] cursor-pointer transition-[background,color] duration-150 whitespace-nowrap hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ${effortLevel === opt.value ? "bg-[var(--text-primary)] text-white" : ""}`}
                onClick={() => setEffortLevel(opt.value)}
                title={opt.description}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </SettingsRow>
      </div>
    </section>
  );
}
