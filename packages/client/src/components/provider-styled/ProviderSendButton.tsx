import { useProviderTheme } from "../../contexts/ProviderThemeContext";

interface ProviderSendButtonProps {
  onClick: () => void;
  disabled?: boolean;
  children?: React.ReactNode;
}

export function ProviderSendButton({
  onClick,
  disabled,
  children,
}: ProviderSendButtonProps) {
  const { activeProvider } = useProviderTheme();

  const baseStyles: React.CSSProperties = {
    padding: "10px 20px",
    borderRadius: activeProvider === "opencode" ? "4px" : "8px",
    border:
      activeProvider === "opencode"
        ? "1px solid var(--accent-primary)"
        : "none",
    background:
      activeProvider === "gemini"
        ? "linear-gradient(135deg, #4285f4, #ea4335)"
        : activeProvider === "opencode"
          ? "transparent"
          : "var(--accent-primary)",
    color: activeProvider === "opencode" ? "var(--accent-primary)" : "#ffffff",
    fontFamily: "var(--font-body)",
    fontWeight: 600,
    fontSize: "14px",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    transition: activeProvider === "opencode" ? "none" : "all 200ms ease",
  };

  return (
    <button
      type="button"
      className="send-button"
      style={baseStyles}
      onClick={onClick}
      disabled={disabled}
    >
      {children ?? "Send"}
    </button>
  );
}
