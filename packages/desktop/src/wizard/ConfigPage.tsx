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
    <div style={{ width: "100%", maxWidth: 400 }}>
      <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>
        Settings
      </h2>
      <p
        style={{
          color: "var(--text-secondary)",
          fontSize: 14,
          marginBottom: 24,
        }}
      >
        Configure how Yep Anywhere runs. You can change these later.
      </p>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          marginBottom: 32,
        }}
      >
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

      <button className="btn-primary" onClick={onNext} style={{ width: "100%" }}>
        Continue
      </button>
    </div>
  );
}
