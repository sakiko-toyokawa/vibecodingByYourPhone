interface Props {
  startMinimized: boolean;
  onStartMinimizedChange: (v: boolean) => void;
  autostart: boolean;
  onAutostartChange: (v: boolean) => void;
  onNext: () => void;
}

export function ConfigPage({
  startMinimized,
  onStartMinimizedChange,
  autostart,
  onAutostartChange,
  onNext,
}: Props) {
  return (
    <div className="w-full max-w-[400px]">
      <h2 className="mb-2 text-[22px] font-semibold">Settings</h2>
      <p className="mb-6 text-sm text-[var(--wizard-text-secondary)]">
        Configure how Yep Anywhere runs. You can change these later.
      </p>

      <div className="mb-8 flex flex-col gap-1">
        <label className="toggle">
          <span>Start when I log in</span>
          <input
            type="checkbox"
            checked={autostart}
            onChange={(e) => onAutostartChange(e.target.checked)}
          />
        </label>

        <label className="toggle">
          <span>Start minimized to tray</span>
          <input
            type="checkbox"
            checked={startMinimized}
            onChange={(e) => onStartMinimizedChange(e.target.checked)}
          />
        </label>
      </div>

      <button className="btn-primary w-full" onClick={onNext}>
        Continue
      </button>
    </div>
  );
}
