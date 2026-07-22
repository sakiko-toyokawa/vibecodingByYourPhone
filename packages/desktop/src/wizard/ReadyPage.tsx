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
    <div className="max-w-[400px] text-center">
      <h2 className="mb-3 text-[28px] font-semibold">
        You're all set!
      </h2>
      <p className="mb-8 text-[15px] leading-relaxed text-[var(--wizard-text-secondary)]">
        Yep Anywhere is ready to go. Click below to start the server and open
        your dashboard.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-[var(--wizard-error)] bg-[rgba(239,68,68,0.1)] p-3 text-[13px] text-[var(--wizard-error)]">
          {error}
        </div>
      )}

      <button
        className="btn-primary px-8 py-3 text-base"
        onClick={launch}
        disabled={launching}
      >
        {launching ? "Starting..." : "Launch Yep Anywhere"}
      </button>
    </div>
  );
}
