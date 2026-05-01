import { useDeveloperMode } from "../../hooks/useDeveloperMode";
import { FONT_SIZES, useFontSize } from "../../hooks/useFontSize";
import { useFunPhrases } from "../../hooks/useFunPhrases";
import { useStreamingEnabled } from "../../hooks/useStreamingEnabled";
import { TAB_SIZES, useTabSize } from "../../hooks/useTabSize";
import { SUPPORTED_LOCALES, useI18n } from "../../i18n";
import {
  getFontSizeLabel,
  getLocaleLabel,
  getTabSizeLabel,
} from "../../i18n-settings";

export function AppearanceSettings() {
  const { locale, setLocale, t } = useI18n();
  const { fontSize, setFontSize } = useFontSize();
  const { tabSize, setTabSize } = useTabSize();
  const { streamingEnabled, setStreamingEnabled } = useStreamingEnabled();
  const { funPhrasesEnabled, setFunPhrasesEnabled } = useFunPhrases();
  const { showConnectionBars, setShowConnectionBars } = useDeveloperMode();
  const translate = (key: string) => t(key as never);

  return (
    <section className="flex flex-col gap-8 mb-12">
      <h2
        style={{ fontFamily: "var(--font-display)" }}
        className="text-[2rem] text-[var(--text-primary)] mb-2"
      >
        {t("appearanceSectionTitle")}
      </h2>
      <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
        <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
          <div className="flex flex-col gap-1">
            <strong>{t("appearanceLanguageTitle")}</strong>
            <p>{t("appearanceLanguageDescription")}</p>
          </div>
          <select
            className="px-3 py-2 rounded-md border border-[var(--border-input)] bg-[var(--bg-input)] text-sm text-[var(--text-primary)] cursor-pointer"
            value={locale}
            onChange={(e) =>
              setLocale(e.target.value as (typeof SUPPORTED_LOCALES)[number])
            }
            aria-label={t("appearanceLanguageTitle")}
          >
            {SUPPORTED_LOCALES.map((value) => (
              <option key={value} value={value}>
                {getLocaleLabel(value, translate)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
          <div className="flex flex-col gap-1">
            <strong>{t("appearanceFontSizeTitle")}</strong>
            <p>{t("appearanceFontSizeDescription")}</p>
          </div>
          <div className="flex gap-[2px] bg-[var(--bg-surface)] border border-[var(--border-color)] rounded-[var(--radius-md)] p-[2px]">
            {FONT_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                className={`px-[var(--space-2)] py-[var(--space-1)] bg-transparent border-none rounded-[var(--radius-sm)] text-[var(--text-muted)] [font-size:var(--font-size-sm)] cursor-pointer transition-[background,color] duration-150 whitespace-nowrap hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ${fontSize === size ? "bg-[var(--text-primary)] text-white" : ""}`}
                onClick={() => setFontSize(size)}
              >
                {getFontSizeLabel(size, translate)}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
          <div className="flex flex-col gap-1">
            <strong>{t("appearanceTabSizeTitle")}</strong>
            <p>{t("appearanceTabSizeDescription")}</p>
          </div>
          <div className="flex gap-[2px] bg-[var(--bg-surface)] border border-[var(--border-color)] rounded-[var(--radius-md)] p-[2px]">
            {TAB_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                className={`px-[var(--space-2)] py-[var(--space-1)] bg-transparent border-none rounded-[var(--radius-sm)] text-[var(--text-muted)] [font-size:var(--font-size-sm)] cursor-pointer transition-[background,color] duration-150 whitespace-nowrap hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ${tabSize === size ? "bg-[var(--text-primary)] text-white" : ""}`}
                onClick={() => setTabSize(size)}
              >
                {getTabSizeLabel(size)}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
          <div className="flex flex-col gap-1">
            <strong>{t("appearanceStreamingTitle")}</strong>
            <p>{t("appearanceStreamingDescription")}</p>
          </div>
          <label className="relative inline-block w-[44px] h-[24px] shrink-0">
            <input
              type="checkbox"
              className="opacity-0 w-0 h-0"
              checked={streamingEnabled}
              onChange={(e) => setStreamingEnabled(e.target.checked)}
            />
            <span className="absolute cursor-pointer inset-0 bg-[var(--bg-hover)] border border-[var(--border-color)] transition-[background-color,border-color] duration-200 rounded-full before:absolute before:content-[''] before:h-[18px] before:w-[18px] before:left-[2px] before:bottom-[2px] before:bg-[var(--text-muted)] before:transition-transform before:duration-200 before:rounded-full" />
          </label>
        </div>
        <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
          <div className="flex flex-col gap-1">
            <strong>{t("appearanceFunPhrasesTitle")}</strong>
            <p>{t("appearanceFunPhrasesDescription")}</p>
          </div>
          <label className="relative inline-block w-[44px] h-[24px] shrink-0">
            <input
              type="checkbox"
              className="opacity-0 w-0 h-0"
              checked={funPhrasesEnabled}
              onChange={(e) => setFunPhrasesEnabled(e.target.checked)}
            />
            <span className="absolute cursor-pointer inset-0 bg-[var(--bg-hover)] border border-[var(--border-color)] transition-[background-color,border-color] duration-200 rounded-full before:absolute before:content-[''] before:h-[18px] before:w-[18px] before:left-[2px] before:bottom-[2px] before:bg-[var(--text-muted)] before:transition-transform before:duration-200 before:rounded-full" />
          </label>
        </div>
        <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
          <div className="flex flex-col gap-1">
            <strong>{t("appearanceConnectionBarsTitle")}</strong>
            <p>{t("appearanceConnectionBarsDescription")}</p>
          </div>
          <label className="relative inline-block w-[44px] h-[24px] shrink-0">
            <input
              type="checkbox"
              className="opacity-0 w-0 h-0"
              checked={showConnectionBars}
              onChange={(e) => setShowConnectionBars(e.target.checked)}
            />
            <span className="absolute cursor-pointer inset-0 bg-[var(--bg-hover)] border border-[var(--border-color)] transition-[background-color,border-color] duration-200 rounded-full before:absolute before:content-[''] before:h-[18px] before:w-[18px] before:left-[2px] before:bottom-[2px] before:bg-[var(--text-muted)] before:transition-transform before:duration-200 before:rounded-full" />
          </label>
        </div>
      </div>
    </section>
  );
}
