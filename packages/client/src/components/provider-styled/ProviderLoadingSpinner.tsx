import { useProviderTheme } from "../../contexts/ProviderThemeContext";

interface ProviderLoadingSpinnerProps {
  size?: number;
}

export function ProviderLoadingSpinner({
  size = 24,
}: ProviderLoadingSpinnerProps) {
  const { activeProvider } = useProviderTheme();

  const dotColor = "var(--accent-primary)";

  if (activeProvider === "gemini") {
    return (
      <div
        style={{
          display: "flex",
          gap: "4px",
          alignItems: "center",
          justifyContent: "center",
          height: size,
        }}
      >
        {["#4285f4", "#ea4335", "#fbbc04", "#34a853"].map((color) => (
          <span
            key={color}
            className="thinking-dot"
            style={{
              width: size * 0.25,
              height: size * 0.25,
              borderRadius: "50%",
              backgroundColor: color,
              display: "inline-block",
            }}
          />
        ))}
      </div>
    );
  }

  if (activeProvider === "opencode") {
    return (
      <div
        style={{
          width: size * 1.5,
          height: 3,
          backgroundColor: "var(--border-subtle)",
          borderRadius: "2px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: "40%",
            height: "100%",
            backgroundColor: dotColor,
            animation: "opencodeProgress 1s linear infinite",
          }}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        gap: "4px",
        alignItems: "center",
        justifyContent: "center",
        height: size,
      }}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="thinking-dot"
          style={{
            width: size * 0.25,
            height: size * 0.25,
            borderRadius: "50%",
            backgroundColor: dotColor,
            display: "inline-block",
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </div>
  );
}
