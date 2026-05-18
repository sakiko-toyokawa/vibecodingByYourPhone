interface Props {
  onNext: () => void;
}

export function WelcomePage({ onNext }: Props) {
  return (
    <div className="max-w-[420px] text-center">
      <h1 className="mb-3 text-[28px] font-semibold">Welcome to Yep Anywhere</h1>
      <p className="mb-8 text-[15px] leading-relaxed text-[var(--wizard-text-secondary)]">
        Supervise your AI coding agents from anywhere. We&apos;ll get you set up in a
        few minutes.
      </p>
      <button className="btn-primary px-8 py-3 text-base" onClick={onNext}>
        Get Started
      </button>
    </div>
  );
}
