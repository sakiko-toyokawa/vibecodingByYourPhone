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
    <section className="settings-section">
      <h2>{t("modelSettingsTitle")}</h2>
      <div className="settings-group">
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("modelSettingsModelTitle")}</strong>
            <p>{t("modelSettingsModelDescription")}</p>
          </div>
          <div className="font-size-selector">
            {MODEL_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`font-size-option ${model === opt.value ? "active" : ""}`}
                onClick={() => setModel(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("modelSettingsEffortTitle")}</strong>
            <p>{t("modelSettingsEffortDescription")}</p>
          </div>
          <div className="font-size-selector">
            {EFFORT_LEVEL_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`font-size-option ${effortLevel === opt.value ? "active" : ""}`}
                onClick={() => setEffortLevel(opt.value)}
                title={opt.description}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
