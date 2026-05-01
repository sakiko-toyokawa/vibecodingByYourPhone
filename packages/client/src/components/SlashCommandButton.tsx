import { useCallback, useEffect, useRef, useState } from "react";

interface SlashCommandButtonProps {
  /** Available slash commands (without the "/" prefix) */
  commands: string[];
  /** Callback when a command is selected */
  onSelectCommand: (command: string) => void;
  /** Whether the button should be disabled */
  disabled?: boolean;
}

/**
 * Button that shows available slash commands in a dropdown menu.
 * Selecting a command inserts "/{command}" into the message input.
 */
export function SlashCommandButton({
  commands,
  onSelectCommand,
  disabled,
}: SlashCommandButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Close menu on Escape
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const handleCommandClick = useCallback(
    (command: string) => {
      onSelectCommand(`/${command}`);
      setIsOpen(false);
    },
    [onSelectCommand],
  );

  // Don't render if no commands available
  if (commands.length === 0) {
    return null;
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        className={`flex min-w-7 items-center justify-center rounded-md border px-2 py-1 text-sm font-semibold leading-none transition-colors ${
          isOpen
            ? "border-[var(--border-input)] bg-[var(--bg-hover)] text-[var(--text-primary)]"
            : "border-[var(--border-color)] bg-transparent text-[var(--text-muted)] hover:border-[var(--border-input)] hover:bg-[var(--bg-hover)]"
        } disabled:cursor-not-allowed disabled:opacity-50`}
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        title="Slash commands"
        aria-label="Show slash commands"
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <span>/</span>
      </button>
      {isOpen && (
        <div
          ref={menuRef}
          className="absolute bottom-full left-0 z-100 mb-1 max-h-60 min-w-40 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border-color)] bg-[var(--bg-surface)] shadow-[0_4px_12px_rgba(0,0,0,0.3)]"
          role="menu"
          aria-label="Slash commands"
        >
          {commands.map((command) => (
            <button
              key={command}
              type="button"
              className="block w-full px-3 py-2 text-left [font-family:var(--font-mono)] text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
              onClick={() => handleCommandClick(command)}
              role="menuitem"
            >
              /{command}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
