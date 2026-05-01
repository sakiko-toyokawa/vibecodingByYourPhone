import { useNavigate } from "react-router-dom";
import { useRemoteBasePath } from "../../../hooks/useRemoteBasePath";
import type { OnboardingStepProps } from "../types";

/**
 * Onboarding step explaining remote access.
 * Provides info and option to configure remote access in settings.
 */
export function RemoteAccessStep({
  onNext,
  onSkip,
  isLastStep,
}: OnboardingStepProps) {
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();

  const handleGoToSettings = () => {
    onNext(); // Complete onboarding first
    navigate(`${basePath}/settings/remote`);
  };

  return (
    <div className="flex flex-col gap-[var(--space-4)]">
      <p className="m-0 [font-size:var(--font-size-base)] leading-[1.5] text-[var(--text-secondary)]">
        Access yepanywhere from anywhere using a secure relay connection. This
        lets you supervise coding agents from your phone while away from your
        computer.
      </p>

      <div className="rounded-[var(--radius-md)] border border-[var(--border-color)] bg-[var(--bg-code)] p-[var(--space-3)]">
        <h4 className="m-0 mb-[var(--space-2)] [font-size:var(--font-size-base)] font-semibold text-[var(--text-primary)]">
          What you'll need:
        </h4>
        <ul className="m-0 pl-[var(--space-4)] [font-size:var(--font-size-sm)] text-[var(--text-secondary)]">
          <li className="mb-[var(--space-1)]">
            A relay server URL (self-hosted or provided by your admin)
          </li>
          <li className="mb-[var(--space-1)]">
            A username to identify your server
          </li>
          <li className="mb-[var(--space-1)]">
            A password for secure authentication
          </li>
        </ul>
      </div>

      <p className="m-0 [font-size:var(--font-size-sm)] text-[var(--text-muted)]">
        You can skip this for now and set it up later in Settings.
      </p>

      <div className="flex justify-end gap-[var(--space-2)] border-t border-[var(--border-subtle)] pt-[var(--space-3)]">
        <button type="button" className="btn-secondary" onClick={onSkip}>
          {isLastStep ? "Skip & Finish" : "Skip"}
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={handleGoToSettings}
        >
          Set Up Remote Access
        </button>
      </div>
    </div>
  );
}
