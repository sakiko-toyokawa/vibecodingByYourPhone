import { useState } from "react";
import type { RemoteExecutorTestResult } from "../../api/client";
import { useRemoteExecutors } from "../../hooks/useRemoteExecutors";
import { useI18n } from "../../i18n";

interface ExecutorStatus {
  testing: boolean;
  result?: RemoteExecutorTestResult;
}

export function RemoteExecutorsSettings() {
  const { t } = useI18n();
  const { executors, loading, addExecutor, removeExecutor, testExecutor } =
    useRemoteExecutors();

  const [newHost, setNewHost] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [executorStatus, setExecutorStatus] = useState<
    Record<string, ExecutorStatus>
  >({});

  const handleAddExecutor = async () => {
    if (!newHost.trim() || isAdding) return;

    setIsAdding(true);
    setAddError(null);

    try {
      await addExecutor(newHost.trim());
      setNewHost("");
    } catch (err) {
      setAddError(
        err instanceof Error ? err.message : t("remoteExecutorsAddFailed"),
      );
    } finally {
      setIsAdding(false);
    }
  };

  const handleRemoveExecutor = async (host: string) => {
    try {
      await removeExecutor(host);
      // Clear status for removed executor
      setExecutorStatus((prev) => {
        const { [host]: _, ...rest } = prev;
        return rest;
      });
    } catch (err) {
      console.error("Failed to remove executor:", err);
    }
  };

  const handleTestExecutor = async (host: string) => {
    setExecutorStatus((prev) => ({
      ...prev,
      [host]: { testing: true },
    }));

    try {
      const result = await testExecutor(host);
      setExecutorStatus((prev) => ({
        ...prev,
        [host]: { testing: false, result },
      }));
    } catch (err) {
      setExecutorStatus((prev) => ({
        ...prev,
        [host]: {
          testing: false,
          result: {
            success: false,
            error:
              err instanceof Error
                ? err.message
                : t("remoteExecutorsConnectionFailed"),
          },
        },
      }));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddExecutor();
    }
  };

  return (
    <section className="flex flex-col gap-8 mb-12">
      <h2
        style={{ fontFamily: "var(--font-display)" }}
        className="text-[2rem] text-[var(--text-primary)] mb-2"
      >
        {t("remoteExecutorsTitle")}
      </h2>
      <p className="m-0 mb-[var(--space-3)] [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
        {t("remoteExecutorsDescription")}
      </p>

      {/* Add new executor */}
      <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
        <div className="flex items-center justify-between py-5 border-b border-[var(--border-subtle)]">
          <div className="flex flex-col gap-1">
            <strong>{t("remoteExecutorsAddTitle")}</strong>
            <p>{t("remoteExecutorsAddDescription")}</p>
          </div>
          <div className="flex gap-[var(--space-2)] mt-[var(--space-2)]">
            <input
              type="text"
              value={newHost}
              onChange={(e) => setNewHost(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t("remoteExecutorsHostPlaceholder")}
              disabled={isAdding}
              className="flex-1 px-[var(--space-2)] py-[var(--space-2)] bg-[var(--bg-input)] border border-[var(--border-input)] rounded-[var(--radius-sm)] text-[var(--text-primary)] [font-size:var(--font-size-sm)] outline-none focus:border-[var(--focus-border)]"
            />
            <button
              type="button"
              onClick={handleAddExecutor}
              disabled={!newHost.trim() || isAdding}
              className="px-[var(--space-2)] py-[var(--space-2)] bg-[var(--text-primary)] border-none rounded-[var(--radius-sm)] text-white [font-size:var(--font-size-sm)] cursor-pointer transition-opacity duration-150 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isAdding ? t("remoteExecutorsAdding") : t("remoteExecutorsAdd")}
            </button>
          </div>
          {addError && (
            <p className="text-xs text-[var(--error-color)] mt-1">{addError}</p>
          )}
        </div>
      </div>

      {/* Executor list */}
      <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
        <h3>{t("remoteExecutorsConfigured")}</h3>
        {loading ? (
          <p className="flex items-center justify-center py-8 text-sm text-[var(--text-muted)]">
            {t("loginLoading")}
          </p>
        ) : executors.length === 0 ? (
          <p className="text-center py-8 text-sm text-[var(--text-dimmed)]">
            {t("remoteExecutorsEmpty")}
          </p>
        ) : (
          <div className="flex flex-col gap-[var(--space-2)]">
            {executors.map((host) => {
              const status = executorStatus[host];
              return (
                <div
                  key={host}
                  className="p-[var(--space-3)] bg-[var(--bg-secondary)] rounded-[var(--radius-md)]"
                >
                  <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-2)]">
                    <span className="font-medium [font-family:var(--font-mono)]">
                      {host}
                    </span>
                    {status?.result && (
                      <span
                        className={`px-[var(--space-2)] py-[var(--space-1)] rounded-[var(--radius-sm)] [font-size:var(--font-size-sm)] font-medium ${status.result.success ? "bg-[var(--bg-hover)] text-[var(--text-secondary)]" : "bg-[var(--bg-hover)] text-[var(--text-muted)]"}`}
                      >
                        {status.result.success
                          ? t("remoteExecutorsConnected")
                          : t("remoteExecutorsFailed")}
                      </span>
                    )}
                  </div>
                  {status?.result && !status.result.success && (
                    <p className="text-xs text-[var(--error-color)] my-[var(--space-2)]">
                      {status.result.error}
                    </p>
                  )}
                  {status?.result?.success && (
                    <p className="[font-size:var(--font-size-sm)] text-[var(--text-muted)] my-[var(--space-2)]">
                      {status.result.claudeAvailable
                        ? status.result.claudeVersion
                          ? t("remoteExecutorsClaudeVersion", {
                              version: status.result.claudeVersion,
                            })
                          : t("remoteExecutorsClaudeAvailable")
                        : t("remoteExecutorsClaudeMissing")}
                    </p>
                  )}
                  <div className="flex gap-[var(--space-2)]">
                    <button
                      type="button"
                      onClick={() => handleTestExecutor(host)}
                      disabled={status?.testing}
                      className="px-[var(--space-2)] py-[var(--space-1)] bg-[var(--bg-hover)] border border-[var(--border-color)] rounded-[var(--radius-sm)] text-[var(--text-primary)] [font-size:var(--font-size-xs)] cursor-pointer transition-[background] duration-150 hover:bg-[var(--border-color)] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {status?.testing
                        ? t("remoteExecutorsTesting")
                        : t("remoteExecutorsTestConnection")}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveExecutor(host)}
                      className="px-[var(--space-2)] py-[var(--space-1)] bg-[var(--bg-hover)] border border-[var(--border-color)] rounded-[var(--radius-sm)] text-[var(--error-color)] [font-size:var(--font-size-xs)] cursor-pointer transition-[background] duration-150 hover:bg-[var(--border-color)] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {t("remoteExecutorsRemove")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Help text */}
      <div className="flex flex-col gap-[var(--space-3)] mb-[var(--space-4)]">
        <h3>{t("remoteExecutorsSetupRequirements")}</h3>
        <ul className="m-0 pl-[var(--space-4)] [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
          <li className="mb-[var(--space-1)]">
            {t("remoteExecutorsRequirementSshConfig")}
          </li>
          <li className="mb-[var(--space-1)]">
            {t("remoteExecutorsRequirementKeyAuth")}
          </li>
          <li className="mb-[var(--space-1)]">
            {t("remoteExecutorsRequirementClaude")}
          </li>
          <li className="mb-[var(--space-1)]">
            {t("remoteExecutorsRequirementPaths")}
          </li>
        </ul>
      </div>
    </section>
  );
}
