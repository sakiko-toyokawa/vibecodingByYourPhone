import { useState } from "react";
import { enable as enableAutostart } from "@tauri-apps/plugin-autostart";
import { saveConfig, startServer, type AppConfig } from "../tauri";

interface Props {
  agents: string[];
  startMinimized: boolean;
  autostart: boolean;
  onComplete: (config: AppConfig) => void;
}

export function ReadyPage({
  agents,
  startMinimized,
  autostart,
  onComplete,
}: Props) {
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const launch = async () => {
    setLaunching(true);
    setError(null);

    const config: AppConfig = {
      setup_complete: true,
      agents,
      start_minimized: startMinimized,
    };

    try {
      await saveConfig(config);
      if (autostart) {
        await enableAutostart();
      }
      await startServer();
      onComplete(config);
    } catch (e) {
      setError(String(e));
      setLaunching(false);
    }
  };

  return (
    <div style={{ textAlign: "center", maxWidth: 400 }}>
      <h2 style={{ fontSize: 28, fontWeight: 600, marginBottom: 12 }}>
        You're all set!
      </h2>
      <p
        style={{
          color: "var(--text-secondary)",
          fontSize: 15,
          lineHeight: 1.6,
          marginBottom: 32,
        }}
      >
        Yep Anywhere is ready to go. Click below to start the server and open
        your dashboard.
      </p>

      {error && (
        <div
          style={{
            padding: 12,
            background: "rgba(239, 68, 68, 0.1)",
            border: "1px solid var(--error)",
            borderRadius: 8,
            fontSize: 13,
            color: "var(--error)",
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      <button
        className="btn-primary"
        onClick={launch}
        disabled={launching}
        style={{ fontSize: 16, padding: "12px 32px" }}
      >
        {launching ? "Starting..." : "Launch Yep Anywhere"}
      </button>
    </div>
  );
}
