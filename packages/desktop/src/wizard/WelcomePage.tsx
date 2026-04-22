interface Props {
  onNext: () => void;
}

export function WelcomePage({ onNext }: Props) {
  return (
    <div style={{ textAlign: "center", maxWidth: 420 }}>
      <h1 style={{ fontSize: 28, fontWeight: 600, marginBottom: 12 }}>
        Welcome to Yep Anywhere
      </h1>
      <p
        style={{
          color: "var(--text-secondary)",
          fontSize: 15,
          lineHeight: 1.6,
          marginBottom: 32,
        }}
      >
        Supervise your AI coding agents from anywhere. We'll get you set up in a
        few minutes.
      </p>
      <button className="btn-primary" onClick={onNext} style={{ fontSize: 16, padding: "12px 32px" }}>
        Get Started
      </button>
    </div>
  );
}
