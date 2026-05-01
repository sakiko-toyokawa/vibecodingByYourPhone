import { useState } from "react";
import { Modal } from "../ui/Modal";
import { RemoteAccessStep, ThemeStep } from "./steps";
import type { OnboardingStepConfig } from "./types";

/**
 * Extensible step registry - add new steps here.
 * The order in this array determines the wizard flow.
 */
const ONBOARDING_STEPS: OnboardingStepConfig[] = [
  {
    id: "theme",
    title: "Choose Your Theme",
    component: ThemeStep,
  },
  {
    id: "remote-access",
    title: "Remote Access",
    component: RemoteAccessStep,
  },
];

interface OnboardingWizardProps {
  /** Called when onboarding is complete (finished or skipped) */
  onComplete: () => void;
}

/**
 * Multi-step onboarding wizard shown on first launch.
 * Guides users through initial setup: theme selection and remote access info.
 */
export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);

  const currentStep = ONBOARDING_STEPS[currentStepIndex];

  // Guard against undefined (shouldn't happen in practice)
  if (!currentStep) {
    onComplete();
    return null;
  }

  const isLastStep = currentStepIndex === ONBOARDING_STEPS.length - 1;
  const StepComponent = currentStep.component;

  const handleNext = () => {
    if (isLastStep) {
      onComplete();
    } else {
      setCurrentStepIndex((prev) => prev + 1);
    }
  };

  const handleSkip = () => {
    if (isLastStep) {
      onComplete();
    } else {
      setCurrentStepIndex((prev) => prev + 1);
    }
  };

  const handleSkipAll = () => {
    onComplete();
  };

  const handleBack = () => {
    if (currentStepIndex > 0) {
      setCurrentStepIndex((prev) => prev - 1);
    }
  };

  const isFirstStep = currentStepIndex === 0;

  const modalTitle = (
    <div className="flex items-center gap-[var(--space-3)]">
      <span>Welcome to yepanywhere</span>
      <span className="[font-size:var(--font-size-sm)] font-normal text-[var(--text-muted)]">
        Step {currentStepIndex + 1} of {ONBOARDING_STEPS.length}
      </span>
    </div>
  );

  return (
    <Modal title={modalTitle} onClose={handleSkipAll}>
      <div className="flex flex-col gap-[var(--space-4)] p-[var(--space-2)]">
        <h2 className="m-0 text-[1.25rem] font-semibold text-[var(--text-primary)]">
          {currentStep.title}
        </h2>

        <StepComponent
          onNext={handleNext}
          onSkip={handleSkip}
          isLastStep={isLastStep}
        />

        <div className="flex items-center justify-between border-t border-[var(--border-subtle)] pt-[var(--space-3)]">
          <button
            type="button"
            className="cursor-pointer rounded-[var(--radius-sm)] border-none bg-transparent p-[var(--space-1)] px-[var(--space-2)] [font-size:var(--font-size-sm)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
            onClick={handleSkipAll}
          >
            Skip all
          </button>
          <div className="flex items-center gap-[var(--space-3)]">
            {!isFirstStep && (
              <button
                type="button"
                className="cursor-pointer rounded-[var(--radius-sm)] border-none bg-transparent p-[var(--space-1)] px-[var(--space-2)] [font-size:var(--font-size-sm)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                onClick={handleBack}
              >
                Back
              </button>
            )}
            <div className="flex gap-[var(--space-2)]">
              {ONBOARDING_STEPS.map((step, index) => (
                <span
                  key={step.id}
                  className={`h-2 w-2 rounded-full transition-[background] duration-150 ${
                    index === currentStepIndex
                      ? "bg-[var(--accent-rust)]"
                      : index < currentStepIndex
                        ? "bg-[var(--accent-rust-dark)]"
                        : "bg-[var(--border-color)]"
                  }`}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
