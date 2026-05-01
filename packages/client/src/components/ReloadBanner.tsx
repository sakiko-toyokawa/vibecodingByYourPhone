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
      className={`fixed top-[env(safe-area-inset-top,0px)] left-0 right-0 z-[200] text-[var(--text-primary)] py-2 px-4 flex items-center gap-3 text-sm max-sm:flex-wrap max-sm:gap-2 max-sm:p-2 ${showWarning ? "bg-[var(--error-color)] text-white" : "bg-[var(--warning-color)]"}`}
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
        className={`px-2 py-1 border border-black/30 rounded-[var(--radius-sm)] text-sm font-medium cursor-pointer transition-colors duration-150 hover:bg-white/40 ${showWarning ? "bg-black text-[var(--error-color)] border-transparent hover:bg-[#222]" : "bg-black text-[var(--warning-color)] border-transparent hover:bg-[#222]"}`}
        onClick={onReload}
      >
        {showWarning ? "Reload Anyway" : `Reload ${label}`}
      </button>
      <button
        type="button"
        className="px-2 py-1 border border-black/30 rounded-[var(--radius-sm)] bg-white/20 text-black text-sm font-medium cursor-pointer transition-colors duration-150 hover:bg-white/40"
        onClick={onDismiss}
      >
        Dismiss
      </button>
      <span className="font-mono [font-size:var(--font-size-xs)] px-1.5 py-0.5 bg-black/15 rounded-[var(--radius-sm)] text-black/60 max-sm:hidden">
        Ctrl+Shift+R
      </span>
    </div>
  );
}
