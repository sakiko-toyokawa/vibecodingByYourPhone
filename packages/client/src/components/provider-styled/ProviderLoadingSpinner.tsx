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
        className="flex items-center justify-center gap-1"
        style={{ height: size }}
      >
        {["#4285f4", "#ea4335", "#fbbc04", "#34a853"].map((color) => (
          <span
            key={color}
            className="thinking-dot inline-block rounded-full"
            style={{
              width: size * 0.25,
              height: size * 0.25,
              backgroundColor: color,
            }}
          />
        ))}
      </div>
    );
  }

  if (activeProvider === "opencode") {
    return (
      <div
        className="bg-[var(--border-subtle)] rounded-sm overflow-hidden"
        style={{ width: size * 1.5, height: 3 }}
      >
        <div
          className="h-full bg-[var(--accent-primary)] animate-[opencodeProgress_1s_linear_infinite]"
          style={{ width: "40%" }}
        />
      </div>
    );
  }

  return (
    <div
      className="flex items-center justify-center gap-1"
      style={{ height: size }}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="thinking-dot inline-block rounded-full"
          style={{
            width: size * 0.25,
            height: size * 0.25,
            backgroundColor: dotColor,
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </div>
  );
}
