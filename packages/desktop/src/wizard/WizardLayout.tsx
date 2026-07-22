import { useState } from "react";
import { type AppConfig } from "../tauri";
import { WelcomePage } from "./WelcomePage";
import { AgentSelectPage } from "./AgentSelectPage";
import { InstallPage } from "./InstallPage";
import { AuthPage } from "./AuthPage";
import { ConfigPage } from "./ConfigPage";
import { ReadyPage } from "./ReadyPage";

const STEPS = ["Welcome", "Agents", "Install", "Sign In", "Settings", "Ready"];

interface Props {
  onComplete: (config: AppConfig) => void;
}

export function WizardLayout({ onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [agents, setAgents] = useState<string[]>(["claude"]);

  const [startMinimized, setStartMinimized] = useState(true);
  const [autostart, setAutostart] = useState(true);

  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));

  const renderStep = () => {
    switch (step) {
      case 0:
        return <WelcomePage onNext={next} />;
      case 1:
        return (
          <AgentSelectPage
            agents={agents}
            onAgentsChange={setAgents}
            onNext={next}
          />
        );
      case 2:
        return <InstallPage agents={agents} onNext={next} />;
      case 3:
        return <AuthPage agents={agents} onNext={next} />;
      case 4:
        return (
          <ConfigPage
            startMinimized={startMinimized}
            onStartMinimizedChange={setStartMinimized}
            autostart={autostart}
            onAutostartChange={setAutostart}
            onNext={next}
          />
        );
      case 5:
        return (
          <ReadyPage
            agents={agents}
            startMinimized={startMinimized}
            autostart={autostart}
            onComplete={onComplete}
          />
        );
    }
  };

  return (
    <div className="flex h-screen flex-col">
      {/* Title bar drag region */}
      <div
        data-tauri-drag-region
        className="shrink-0"
        style={{ height: 32 }}
      />

      {/* Progress dots */}
      <div className="flex justify-center gap-2 pb-6"
      >
        {STEPS.map((_, i) => (
          <div
            key={i}
            className="h-2 w-2 rounded-full transition-colors duration-200"
            style={{
              background: i <= step ? "var(--wizard-accent)" : "var(--wizard-border)",
            }}
          />
        ))}
      </div>

      {/* Step content */}
      <div className="flex flex-1 flex-col items-center justify-center overflow-auto px-12 pb-12"
      >
        {renderStep()}
      </div>
    </div>
  );
}
