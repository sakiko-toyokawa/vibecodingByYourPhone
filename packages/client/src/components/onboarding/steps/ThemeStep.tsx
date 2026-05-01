import type { OnboardingStepProps } from "../types";

/**
 * Onboarding step for theme (now simplified - single theme mode).
 */
export function ThemeStep({ onNext, onSkip, isLastStep }: OnboardingStepProps) {
  return (
    <div className="flex flex-col gap-[var(--space-4)]">
      <p className="m-0 [font-size:var(--font-size-base)] leading-[1.5] text-[var(--text-secondary)]">
        The app uses a unified light literary-tech theme designed for clarity
        and focus.
      </p>

      <div className="flex justify-end gap-[var(--space-2)] border-t border-[var(--border-subtle)] pt-[var(--space-3)]">
        <button type="button" className="btn-secondary" onClick={onSkip}>
          Skip
        </button>
        <button type="button" className="btn-primary" onClick={onNext}>
          {isLastStep ? "Finish" : "Next"}
        </button>
      </div>
    </div>
  );
}
