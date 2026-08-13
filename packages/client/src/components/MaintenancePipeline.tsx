import type { MaintenanceTargetState } from "../api/maintenance";

interface MaintenancePipelineProps {
  state: MaintenanceTargetState;
  targetType?: string;
}

const GENERIC_STAGES: Array<{
  id: MaintenanceTargetState;
  label: string;
}> = [
  { id: "waiting", label: "Waiting" },
  { id: "waking", label: "Waking" },
  { id: "fixing", label: "Fixing" },
];

const GITHUB_STAGES: Array<{
  id: MaintenanceTargetState;
  label: string;
}> = [
  { id: "pending_approval", label: "Pending approval" },
  { id: "awaiting_review", label: "Awaiting review" },
  { id: "awaiting_feedback", label: "Awaiting feedback" },
  { id: "waking", label: "Waking" },
  { id: "fixing", label: "Fixing" },
];

export function MaintenancePipeline({
  state,
  targetType,
}: MaintenancePipelineProps) {
  const stages = targetType === "github_pr" ? GITHUB_STAGES : GENERIC_STAGES;
  const currentIndex = Math.max(
    0,
    stages.findIndex((stage) => stage.id === state),
  );
  const terminal = state === "needs_human" || state === "done";
  const visibleStages = terminal ? stages : stages.slice(0, currentIndex + 1);

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="maintenance-pipeline"
      data-state={state}
    >
      {visibleStages.map((stage, index) => {
        const active = index === currentIndex;
        const completed = index < currentIndex;
        return (
          <span
            key={stage.id}
            className={`flex items-center gap-2 rounded-full border px-2 py-1 text-xs font-medium ${
              active
                ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                : completed
                  ? "border-[var(--border-color)] bg-[var(--bg-hover)] text-[var(--text-muted)]"
                  : "border-[var(--border-color)] bg-[var(--bg-surface)] text-[var(--text-dimmed)]"
            }`}
            data-stage={stage.id}
            data-active={active ? "true" : undefined}
          >
            <span>{stage.label}</span>
            {index < visibleStages.length - 1 && <span>→</span>}
          </span>
        );
      })}
      {terminal && (
        <span
          className={`rounded-full border px-2 py-1 text-xs font-medium ${
            state === "needs_human"
              ? "border-[var(--error-color)] bg-[var(--error-color)]/10 text-[var(--error-color)]"
              : "border-[var(--success-color)] bg-[var(--success-color)]/10 text-[var(--success-color)]"
          }`}
          data-stage={state}
          data-active="true"
        >
          {state === "needs_human" ? "Needs human" : "Done"}
        </span>
      )}
    </div>
  );
}
