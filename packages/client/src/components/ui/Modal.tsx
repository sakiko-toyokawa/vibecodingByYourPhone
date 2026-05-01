import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";

interface ModalProps {
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
}

/**
 * Reusable modal component with overlay, header, and scrollable content area.
 * Renders via portal to avoid event bubbling issues.
 * Closes on Escape key or clicking the overlay.
 */
export function Modal({ title, children, onClose }: ModalProps) {
  const { t } = useI18n();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  // Focus the close button on mount for accessibility
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  const handleOverlayClick = (e: React.MouseEvent) => {
    // Only close if clicking directly on the overlay, not its children
    if (e.target === e.currentTarget) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const handleModalClick = (e: React.MouseEvent) => {
    // Stop propagation to prevent overlay click handler
    e.stopPropagation();
  };

  const modalContent = (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handled globally, click is for overlay dismiss
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-[var(--bg-overlay)] max-[600px]:items-end"
      onClick={handleOverlayClick}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click only stops propagation, keyboard handled globally */}
      <div
        className="flex w-[90vw] max-w-[1200px] max-h-[85vh] flex-col rounded border border-[var(--border-color)] bg-[var(--bg-surface)] shadow-[0_8px_32px_rgba(0,0,0,0.3)] max-[600px]:h-dvh max-[600px]:max-h-dvh max-[600px]:w-screen max-[600px]:max-w-none max-[600px]:rounded-none max-[600px]:border-none"
        role="dialog"
        aria-modal="true"
        onClick={handleModalClick}
      >
        <div className="flex items-center justify-between border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1.5 rounded-t max-[600px]:rounded-none max-[600px]:py-1">
          <span className="min-w-0 overflow-hidden text-[0.9375rem] font-semibold whitespace-nowrap text-[var(--text-primary)] truncate max-[600px]:text-sm">
            {title}
          </span>
          <button
            ref={closeButtonRef}
            type="button"
            className="shrink-0 cursor-pointer border-none bg-transparent px-2 py-1 text-xl leading-none text-[var(--text-primary)] rounded hover:bg-[var(--bg-hover)]"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }}
            aria-label={t("modalClose")}
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-auto p-2 max-[600px]:p-0">
          {children}
        </div>
      </div>
    </div>
  );

  // Use portal to render at document body level
  return createPortal(modalContent, document.body);
}
