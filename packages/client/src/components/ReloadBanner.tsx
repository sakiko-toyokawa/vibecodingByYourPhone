interface Props {
  target: "backend" | "frontend";
  onReload: () => void;
  onDismiss: () => void;
  unsafeToRestart?: boolean;
  activeWorkers?: number;
}

export function ReloadBanner({
  target,
  onReload,
  onDismiss,
  unsafeToRestart,
  activeWorkers,
}: Props) {
  const label = target === "backend" ? "Server" : "Frontend";
  const showWarning = unsafeToRestart && target === "backend";

  return (
    <div
      className={`fixed left-0 right-0 top-[env(safe-area-inset-top,0px)] z-[200] flex items-center gap-3 px-4 py-2 text-sm max-sm:flex-wrap max-sm:gap-2 max-sm:p-2 ${showWarning ? "bg-[var(--bg-error)] text-[var(--error-color)]" : "bg-[var(--bg-warning)] text-[var(--warning-color)]"}`}
    >
      <span className="shrink-0">
        {label} code changed - reload to see changes
      </span>
      {showWarning && (
        <span className="font-semibold">
          {activeWorkers} active session{activeWorkers !== 1 ? "s" : ""} will be
          interrupted
        </span>
      )}
      <button
        type="button"
        className="cursor-pointer rounded-[var(--radius-sm)] border border-current/25 bg-[var(--bg-surface)] px-2 py-1 text-sm font-medium text-[var(--text-primary)] transition-colors duration-150 hover:bg-[var(--bg-hover)]"
        onClick={onReload}
      >
        {showWarning ? "Reload Anyway" : `Reload ${label}`}
      </button>
      <button
        type="button"
        className="cursor-pointer rounded-[var(--radius-sm)] border border-current/25 bg-transparent px-2 py-1 text-sm font-medium text-inherit transition-colors duration-150 hover:bg-current/10"
        onClick={onDismiss}
      >
        Dismiss
      </button>
      <span className="max-sm:hidden rounded-[var(--radius-sm)] bg-current/10 px-1.5 py-0.5 font-mono text-[color:currentColor] opacity-70 [font-size:var(--font-size-xs)]">
        Ctrl+Shift+R
      </span>
    </div>
  );
}
