import { useCallback, useEffect, useState } from "react";
import {
  SettingsTextInput,
  SettingsTextarea,
} from "../../components/settings/SettingsFormControls";
import { useProviders } from "../../hooks/useProviders";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";
import { getAllProviders } from "../../providers/registry";

const DEFAULT_OLLAMA_SYSTEM_PROMPT =
  "You are a helpful coding assistant. You help users with software engineering tasks. You have access to tools for reading files, editing files, running shell commands, and searching code. Use tools when needed to answer questions or make changes. Be concise and direct.";

function OllamaUrlInput() {
  const { t } = useI18n();
  const { settings, updateSetting } = useServerSettings();
  const [url, setUrl] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const serverValue = settings?.ollamaUrl ?? "";

  useEffect(() => {
    if (settings) {
      setUrl(settings.ollamaUrl ?? "");
    }
  }, [settings]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await updateSetting("ollamaUrl", url.trim() || undefined);
      setHasChanges(false);
    } catch {
      // Error handled by useServerSettings
    } finally {
      setIsSaving(false);
    }
  }, [url, updateSetting]);

  return (
    <div className="mt-[var(--space-2)] w-full">
      <div className="flex items-center gap-[var(--space-2)]">
        <SettingsTextInput
          type="text"
          className="flex-1"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setHasChanges(e.target.value !== serverValue);
          }}
          placeholder="http://localhost:11434"
        />
        <button
          type="button"
          className="px-3 py-1.5 rounded-md border border-[var(--border-color)] bg-transparent text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
          disabled={!hasChanges || isSaving}
          onClick={handleSave}
        >
          {isSaving ? t("providersSaving") : t("providersSave")}
        </button>
      </div>
      <span className="text-sm text-[var(--text-muted)]">
        {t("providersOllamaUrlHint")}
      </span>
    </div>
  );
}

function OllamaUseFullSystemPrompt() {
  const { t } = useI18n();
  const { settings, updateSetting } = useServerSettings();
  const enabled = settings?.ollamaUseFullSystemPrompt ?? false;

  return (
    <label className="flex items-center gap-[var(--space-2)] mt-[var(--space-2)] cursor-pointer">
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) =>
          updateSetting("ollamaUseFullSystemPrompt", e.target.checked)
        }
      />
      <span>{t("providersUseFullPrompt")}</span>
      <span className="text-sm text-[var(--text-muted)] ml-auto">
        {t("providersUseFullPromptHint")}
      </span>
    </label>
  );
}

function OllamaSystemPromptInput() {
  const { t } = useI18n();
  const { settings, updateSetting } = useServerSettings();
  const [prompt, setPrompt] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const serverValue = settings?.ollamaSystemPrompt ?? "";

  useEffect(() => {
    if (settings) {
      setPrompt(settings.ollamaSystemPrompt ?? "");
    }
  }, [settings]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await updateSetting("ollamaSystemPrompt", prompt.trim() || undefined);
      setHasChanges(false);
    } catch {
      // Error handled by useServerSettings
    } finally {
      setIsSaving(false);
    }
  }, [prompt, updateSetting]);

  return (
    <div className="mt-[var(--space-2)] w-full">
      <SettingsTextarea
        className="w-full"
        value={prompt}
        onChange={(e) => {
          setPrompt(e.target.value);
          setHasChanges(e.target.value !== serverValue);
        }}
        placeholder={DEFAULT_OLLAMA_SYSTEM_PROMPT}
        rows={4}
      />
      <div className="flex items-center justify-between mt-[var(--space-2)]">
        <span className="text-sm text-[var(--text-muted)]">
          {t("providersOllamaPromptHint")}
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
    </div>
  );
}

function OllamaSettings() {
  const { settings } = useServerSettings();
  const useFullPrompt = settings?.ollamaUseFullSystemPrompt ?? false;

  return (
    <>
      <OllamaUrlInput />
      <OllamaUseFullSystemPrompt />
      {!useFullPrompt && <OllamaSystemPromptInput />}
    </>
  );
}

export function ProvidersSettings() {
  const { t } = useI18n();
  const { providers: serverProviders, loading: providersLoading } =
    useProviders();

  // Merge server detection status with client-side metadata
  const registeredProviders = getAllProviders();
  const providerDisplayList = registeredProviders.map((clientProvider) => {
    const serverInfo = serverProviders.find(
      (p) => p.name === clientProvider.id,
    );
    return {
      ...clientProvider,
      installed: serverInfo?.installed ?? false,
      authenticated: serverInfo?.authenticated ?? false,
    };
  });

  return (
    <section className="flex flex-col gap-8 mb-12">
      <h2
        style={{ fontFamily: "var(--font-display)" }}
        className="text-[2rem] text-[var(--text-primary)] mb-2"
      >
        {t("providersSectionTitle")}
      </h2>
      <p className="mb-[var(--space-3)] text-sm text-[var(--text-muted)]">
        {t("providersSectionDescription")}
      </p>
      <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
        {providerDisplayList.map((provider) => (
          <div
            key={provider.id}
            className="py-5 border-b border-[var(--border-subtle)]"
          >
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-1)]">
                <strong className="mb-0">{provider.displayName}</strong>
                {provider.installed ? (
                  <span className="px-[var(--space-1)] py-[var(--space-2)] rounded-[var(--radius-sm)] text-sm font-medium bg-[var(--bg-hover)] text-[var(--text-secondary)]">
                    {t("providersDetected")}
                  </span>
                ) : (
                  <span className="px-[var(--space-1)] py-[var(--space-2)] rounded-[var(--radius-sm)] text-sm font-medium bg-[var(--bg-hover)] text-[var(--text-muted)]">
                    {t("providersNotDetected")}
                  </span>
                )}
              </div>
              <p>{provider.metadata.description}</p>
              {provider.metadata.limitations.length > 0 && (
                <ul className="mt-[var(--space-2)] pl-[var(--space-4)] text-sm text-[var(--text-muted)]">
                  {provider.metadata.limitations.map((limitation) => (
                    <li
                      key={limitation}
                      className="mb-[var(--space-1)] last:mb-0"
                    >
                      {limitation}
                    </li>
                  ))}
                </ul>
              )}
              {provider.id === "claude-ollama" && <OllamaSettings />}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
