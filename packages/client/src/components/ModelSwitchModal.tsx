import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { Modal } from "./ui/Modal";

interface ModelSwitchModalProps {
  processId: string;
  currentModel?: string;
  onModelChanged: (model: string) => void;
  onClose: () => void;
}

interface ModelOption {
  id: string;
  name: string;
  description?: string;
}

export function ModelSwitchModal({
  processId,
  currentModel,
  onModelChanged,
  onClose,
}: ModelSwitchModalProps) {
  const { t } = useI18n();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    api
      .getProcessModels(processId)
      .then((res) => setModels(res.models))
      .catch((err) => setError(err.message || t("modelSwitchLoadFailed")))
      .finally(() => setLoading(false));
  }, [processId, t]);

  const handleSelect = async (modelId: string) => {
    if (switching) return;
    setSwitching(true);
    setError(null);
    try {
      await api.setProcessModel(processId, modelId);
      onModelChanged(modelId);
      onClose();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : t("modelSwitchChangeFailed"),
      );
      setSwitching(false);
    }
  };

  return (
    <Modal title={t("modelSwitchTitle")} onClose={onClose}>
      <div className="p-2 max-w-[400px]">
        {loading && (
          <div className="[font-size:var(--font-size-sm)] text-[var(--text-muted)] p-4 text-center">
            {t("modelSwitchLoading")}
          </div>
        )}
        {error && (
          <div className="[font-size:var(--font-size-sm)] text-[var(--color-error)] p-4 text-center">
            {error}
          </div>
        )}
        {!loading && !error && models.length === 0 && (
          <div className="[font-size:var(--font-size-sm)] text-[var(--text-muted)] p-4 text-center">
            {t("modelSwitchEmpty")}
          </div>
        )}
        {!loading && models.length > 0 && (
          <div className="flex flex-col gap-0.5">
            {models.map((model) => {
              const isCurrent = currentModel
                ? currentModel.includes(model.id) ||
                  model.id.includes(currentModel)
                : false;
              return (
                <button
                  key={model.id}
                  type="button"
                  className={`flex items-center gap-3 px-4 py-3 bg-transparent border-none rounded-md cursor-pointer text-left w-full text-[var(--text-primary)] [font-size:var(--font-size-sm)] hover:bg-[var(--bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed ${isCurrent ? "bg-[var(--bg-hover)]" : ""}`}
                  onClick={() => handleSelect(model.id)}
                  disabled={switching}
                >
                  <span className="font-medium">{model.name}</span>
                  {model.description && (
                    <span className="text-[var(--text-secondary)] [font-size:var(--font-size-xs)] flex-1">
                      {model.description}
                    </span>
                  )}
                  {isCurrent && (
                    <span className="[font-size:var(--font-size-xs)] text-[var(--accent-color)] font-semibold shrink-0">
                      {t("modelSwitchCurrent")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
