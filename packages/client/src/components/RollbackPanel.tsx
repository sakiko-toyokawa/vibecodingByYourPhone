import { useCallback, useMemo, useState } from "react";
import { api } from "../api/client";
import { useToastContext } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import type { FileChangeEvent } from "../lib/activityBus";

interface RollbackPanelProps {
  changes: FileChangeEvent[];
  projectId: string;
  onClose: () => void;
  onRestoreSuccess: () => void;
}

const CHANGE_TYPE_LABELS: Record<string, string> = {
  create: "rollbackChangeCreate",
  modify: "rollbackChangeModify",
  delete: "rollbackChangeDelete",
};

const CHANGE_TYPE_COLORS: Record<string, string> = {
  create: "bg-[var(--bg-success)] text-[var(--success-color)]",
  modify: "bg-[var(--bg-warning)] text-[var(--warning-color)]",
  delete: "bg-[var(--bg-error)] text-[var(--error-color)]",
};

export function RollbackPanel({
  changes,
  projectId,
  onClose,
  onRestoreSuccess,
}: RollbackPanelProps) {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(
    () => new Set(changes.map((c) => c.relativePath)),
  );
  const [isRestoring, setIsRestoring] = useState(false);

  const allSelected =
    selectedPaths.size === changes.length && changes.length > 0;

  const toggleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(new Set(changes.map((c) => c.relativePath)));
    }
  }, [allSelected, changes]);

  const togglePath = useCallback((path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleRestore = useCallback(async () => {
    if (selectedPaths.size === 0) return;
    setIsRestoring(true);
    try {
      const result = await api.restoreGitFiles(
        projectId,
        Array.from(selectedPaths),
      );
      if (result.failed.length === 0) {
        showToast(
          t("rollbackRestoreSuccess", { count: result.restored.length }),
          "success",
        );
        onRestoreSuccess();
      } else if (result.restored.length === 0) {
        showToast(
          t("rollbackRestoreFailed", {
            count: result.failed.length,
          }),
          "error",
        );
      } else {
        showToast(
          t("rollbackRestorePartial", {
            restored: result.restored.length,
            failed: result.failed.length,
          }),
          "warning",
        );
        onRestoreSuccess();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t("rollbackRestoreError", { message: msg }), "error");
    } finally {
      setIsRestoring(false);
    }
  }, [selectedPaths, projectId, t, onRestoreSuccess, showToast]);

  const sortedChanges = useMemo(() => {
    return [...changes].sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    );
  }, [changes]);

  if (changes.length === 0) {
    return (
      <div className="fixed inset-0 z-50 flex items-end justify-center bg-[var(--bg-overlay)] p-4 sm:items-center">
        <div className="w-full max-w-lg rounded-lg border border-[var(--border-color)] bg-[var(--bg-surface)] p-6 shadow-lg pb-[max(1.5rem,env(safe-area-inset-bottom,0px))]">
          <h3 className="mb-4 text-lg font-medium text-[var(--text-primary)]">
            {t("rollbackPanelTitle")}
          </h3>
          <p className="text-sm text-[var(--text-muted)]">
            {t("rollbackPanelEmpty")}
          </p>
          <div className="mt-6 flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-[var(--border-color)] bg-transparent px-4 py-2 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
            >
              {t("rollbackCancel")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[var(--bg-overlay)] p-4 sm:items-center">
      <div className="flex w-full max-w-lg flex-col rounded-lg border border-[var(--border-color)] bg-[var(--bg-surface)] shadow-lg max-h-[80vh] pb-[max(0px,env(safe-area-inset-bottom,0px))]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
          <h3 className="text-lg font-medium text-[var(--text-primary)]">
            {t("rollbackPanelTitle")}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            aria-label={t("rollbackCancel")}
          >
            ✕
          </button>
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto px-4 py-2">
          <div className="mb-2 flex items-center gap-2">
            <input
              type="checkbox"
              id="rollback-select-all"
              checked={allSelected}
              onChange={toggleSelectAll}
              className="h-4 w-4 rounded border-[var(--border-color)]"
            />
            <label
              htmlFor="rollback-select-all"
              className="cursor-pointer text-sm text-[var(--text-muted)]"
            >
              {t("rollbackSelectAll")}
            </label>
          </div>

          <div className="flex flex-col gap-1">
            {sortedChanges.map((change) => (
              <div
                key={change.relativePath}
                className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-[var(--bg-hover)]"
              >
                <input
                  type="checkbox"
                  checked={selectedPaths.has(change.relativePath)}
                  onChange={() => togglePath(change.relativePath)}
                  className="h-4 w-4 shrink-0 rounded border-[var(--border-color)]"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)] [font-family:var(--font-mono)]">
                  {change.relativePath}
                </span>
                <span
                  className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${CHANGE_TYPE_COLORS[change.changeType] ?? "bg-[var(--bg-secondary)] text-[var(--text-muted)]"}`}
                >
                  {t(
                    (CHANGE_TYPE_LABELS[change.changeType] ??
                      "rollbackChangeModify") as never,
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-center gap-2 border-t border-[var(--border-subtle)] px-4 py-3 sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={isRestoring}
            className="rounded-md border border-[var(--border-color)] bg-transparent px-4 py-2 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            {t("rollbackCancel")}
          </button>
          <button
            type="button"
            onClick={handleRestore}
            disabled={selectedPaths.size === 0 || isRestoring}
            className="rounded-md bg-[var(--text-primary)] px-4 py-2 text-sm text-[var(--bg-surface)] transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {isRestoring
              ? t("rollbackRestoring")
              : t("rollbackRestoreSelected", { count: selectedPaths.size })}
          </button>
        </div>
      </div>
    </div>
  );
}
