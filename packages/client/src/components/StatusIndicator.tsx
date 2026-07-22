import type { ProcessState } from "../hooks/useSession";
import { useI18n } from "../i18n";
import type { SessionStatus } from "../types";

interface Props {
  status: SessionStatus;
  connected: boolean;
  processState?: ProcessState;
}

export function StatusIndicator({
  status,
  connected,
  processState = "idle",
}: Props) {
  const { t } = useI18n();
  // Hide when session has no owner (no active subprocess from UX perspective)
  if (status.owner === "none") {
    return null;
  }

  // Hide in-turn state - now shown in ProviderBadge's thinking indicator
  if (processState === "in-turn" && connected && status.owner === "self") {
    return null;
  }

  // Determine status text for tooltip/accessibility
  const getStatusText = () => {
    if (!connected && status.owner === "self")
      return t("statusReconnecting" as never);
    if (status.owner === "external") return t("statusExternalProcess" as never);
    if (processState === "in-turn") return t("statusProcessing" as never);
    if (processState === "waiting-input")
      return t("statusWaitingForInput" as never);
    return t("statusReady" as never);
  };

  const statusText = getStatusText();

  const dotColorClass = (() => {
    if (!connected) {
      return "bg-[var(--error-color)] animate-[thinking-pulse_1s_ease-in-out_infinite]";
    }
    if (status.owner === "external") {
      return "bg-[var(--warning-color)]";
    }
    if (processState === "waiting-input") {
      return "bg-[var(--warning-color)]";
    }
    if (processState === "in-turn") {
      return "bg-[var(--thinking-color)] animate-[thinking-pulse_1.5s_ease-in-out_infinite]";
    }
    return "bg-[var(--success-color)]";
  })();

  return (
    <div
      className="flex items-center gap-2"
      title={statusText}
      aria-label={statusText}
    >
      <span className={`w-2 h-2 rounded-full ${dotColorClass}`} role="status" />
    </div>
  );
}
