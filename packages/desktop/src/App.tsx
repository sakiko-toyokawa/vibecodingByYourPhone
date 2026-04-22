import { useEffect, useState } from "react";
import { getConfig, type AppConfig } from "./tauri";
import { WizardLayout } from "./wizard/WizardLayout";
import { MainLayout } from "./main/MainLayout";

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getConfig()
      .then(setConfig)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ color: "var(--text-secondary)" }}>Loading...</div>
      </div>
    );
  }

  if (config && config.setup_complete) {
    return <MainLayout />;
  }

  return (
    <WizardLayout
      onComplete={(newConfig) => {
        setConfig(newConfig);
      }}
    />
  );
}
