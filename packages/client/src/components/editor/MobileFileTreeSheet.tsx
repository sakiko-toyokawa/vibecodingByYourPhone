import type { ReactNode } from "react";
import { useEffect } from "react";
import { createPortal } from "react-dom";

interface MobileFileTreeSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  headerAction?: ReactNode;
}

export function MobileFileTreeSheet({
  open,
  onClose,
  title,
  children,
  headerAction,
}: MobileFileTreeSheetProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [open, onClose]);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [open]);

  if (!open) return null;

  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape handled globally, click is for overlay dismiss
    <div
      className="fixed inset-0 z-[10001] flex items-end justify-center bg-[var(--bg-overlay)]"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="flex max-h-[80dvh] w-full flex-col overflow-hidden rounded-t-[1.5rem] border border-b-0 border-[var(--border-color)] bg-[var(--bg-surface)] shadow-[0_-8px_32px_rgba(0,0,0,0.16)]">
        <div className="flex justify-center pb-2 pt-3">
          <div className="h-1.5 w-12 rounded-full bg-[var(--border-color)]" />
        </div>
        <div className="flex items-center justify-between border-b border-[var(--border-color)] px-4 py-3">
          <span className="text-sm font-medium text-[var(--text-primary)]">
            {title}
          </span>
          {headerAction}
        </div>
        <div className="min-h-0 flex-1 overflow-auto pb-[env(safe-area-inset-bottom,0px)]">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
