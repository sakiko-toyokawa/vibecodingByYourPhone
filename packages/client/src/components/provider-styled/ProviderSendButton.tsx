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

  const baseClasses =
    "send-button px-5 py-2.5 font-sans font-semibold text-sm cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 hover:opacity-[0.85]";

  const providerClasses =
    activeProvider === "gemini"
      ? "bg-gradient-to-br from-[#4285f4] to-[#ea4335] text-white rounded-lg transition-all duration-200"
      : activeProvider === "opencode"
        ? "bg-transparent text-[var(--accent-primary)] rounded border border-[var(--accent-primary)] transition-none"
        : "bg-[var(--accent-primary)] text-white rounded-lg transition-all duration-200";

  return (
    <button
      type="button"
      className={`${baseClasses} ${providerClasses}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children ?? "Send"}
    </button>
  );
}
