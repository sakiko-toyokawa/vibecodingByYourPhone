import { useState } from "react";
import { githubApi } from "../api/github";
import type { MaintenanceTarget } from "../api/maintenance";
import { humanizeMaintenanceState } from "../lib/loopHumanText";
import { MaintenancePipeline } from "./MaintenancePipeline";

interface MaintenanceTargetCardProps {
  target: MaintenanceTarget;
  showLoop?: boolean;
  onSendEvent?: (target: MaintenanceTarget) => void;
  onChanged?: () => void | Promise<void>;
}

export function MaintenanceTargetCard({
  target,
  showLoop = false,
  onSendEvent,
  onChanged,
}: MaintenanceTargetCardProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const adapter = target.adapter_data ?? {};
  const relationId =
    typeof adapter.relation_id === "string" ? adapter.relation_id : null;
  const repository =
    typeof adapter.repository === "string" ? adapter.repository : null;
  const prNumber =
    typeof adapter.pr_number === "number" ? adapter.pr_number : null;

  const runPrAction = async (action: "approve" | "ready") => {
    if (!relationId) return;
    setBusy(action);
    setError(null);
    try {
      if (action === "approve") {
        await githubApi.approvePr(relationId);
      } else {
        await githubApi.markReady(relationId);
      }
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-surface)] p-4">
      <button
        type="button"
        className="block w-full text-left"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono [font-size:var(--font-size-sm)] text-[var(--text-primary)]">
            {target.target_type} · {target.target_id}
          </span>
          <span className="rounded-[var(--radius-sm)] bg-[var(--bg-hover)] px-2 py-0.5 text-xs font-medium text-[var(--text-muted)]">
            {humanizeMaintenanceState(target.state)}
          </span>
          <span className="text-xs text-[var(--text-muted)]">
            feedback {target.feedback_count} · repair {target.repair_count}
          </span>
          <span className="ml-auto text-xs text-[var(--text-dimmed)]">
            {open ? "Hide details" : "Show details"}
          </span>
        </div>
      </button>

      <div className="mt-2">
        <MaintenancePipeline
          state={target.state}
          targetType={target.target_type}
        />
      </div>

      <div className="mt-2 text-xs text-[var(--text-muted)]">
        {showLoop ? `loop: ${target.loop_id} · ` : ""}
        triggers: {target.wake_policy.trigger_types.join(", ")}
      </div>

      {open && (
        <div className="mt-3 grid gap-3 border-t border-[var(--border-color)] pt-3">
          <div className="grid gap-2 text-xs text-[var(--text-muted)]">
            <div>wake policy: max repairs {target.wake_policy.max_repairs}</div>
            <div>created: {target.created_at}</div>
            <div>updated: {target.updated_at}</div>
          </div>
          {repository && prNumber && (
            <a
              href={`https://github.com/${repository}/pull/${prNumber}`}
              target="_blank"
              rel="noreferrer"
              className="w-fit text-xs font-medium text-[var(--primary)]"
            >
              Open PR
            </a>
          )}
          {Object.keys(target.external_ref).length > 0 && (
            <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-all [font-size:var(--font-size-xs)] text-[var(--text-dimmed)]">
              external_ref: {JSON.stringify(target.external_ref, null, 2)}
            </pre>
          )}
          {Object.keys(target.context_payload).length > 0 && (
            <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-all [font-size:var(--font-size-xs)] text-[var(--text-dimmed)]">
              context: {JSON.stringify(target.context_payload, null, 2)}
            </pre>
          )}
          {target.target_type === "github_pr" && relationId && (
            <div className="flex flex-wrap gap-2">
              {target.state === "pending_approval" && (
                <button
                  type="button"
                  className="rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--on-primary)] disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => void runPrAction("approve")}
                >
                  {busy === "approve"
                    ? "Publishing..."
                    : "Approve & Publish Draft PR"}
                </button>
              )}
              {target.state === "awaiting_review" && (
                <button
                  type="button"
                  className="rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => void runPrAction("ready")}
                >
                  {busy === "ready"
                    ? "Marking ready..."
                    : "Mark Ready for Review"}
                </button>
              )}
            </div>
          )}
          {error && (
            <p className="text-xs text-[var(--error-color)]">{error}</p>
          )}
          {onSendEvent && (
            <button
              type="button"
              className="w-fit rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--border-hover)]"
              onClick={() => onSendEvent(target)}
            >
              Send test event
            </button>
          )}
        </div>
      )}
    </div>
  );
}
