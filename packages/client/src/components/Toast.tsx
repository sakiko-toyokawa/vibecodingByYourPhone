import type { Toast as ToastType } from "../hooks/useToast";

interface Props {
  toasts: ToastType[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-[calc(100px+env(safe-area-inset-bottom,0px))] left-1/2 -translate-x-1/2 z-[1000] flex flex-col gap-2 pointer-events-none md:bottom-auto md:top-4 md:left-auto md:right-4 md:translate-x-0">
      {toasts.map((toast) => {
        const typeClasses =
          toast.type === "error"
            ? "border border-[var(--error-color)]/20 bg-[var(--bg-error)] text-[var(--error-color)]"
            : toast.type === "success"
              ? "border border-[var(--success-color)]/20 bg-[var(--bg-success)] text-[var(--success-color)]"
              : "bg-[var(--bg-secondary)] text-[var(--text-primary)] border border-[var(--border-color)]";

        const hasAction = !!toast.action;

        return (
          <div
            key={toast.id}
            className={`px-4 py-3 rounded-md text-sm cursor-pointer pointer-events-auto animate-[toast-slide-in_0.2s_ease-out] max-w-[400px] text-center shadow-[0_4px_12px_var(--bg-overlay)] ${typeClasses} ${hasAction ? "flex items-center gap-3 text-left" : ""}`}
            onClick={() => onDismiss(toast.id)}
            onKeyDown={(e) => e.key === "Enter" && onDismiss(toast.id)}
            role="alert"
          >
            <span className={hasAction ? "flex-1" : ""}>{toast.message}</span>
            {toast.action && (
              <button
                type="button"
                className="shrink-0 whitespace-nowrap rounded-sm border border-current/20 bg-current/10 px-2 py-1 text-xs text-inherit hover:bg-current/15"
                onClick={(e) => {
                  e.stopPropagation();
                  toast.action?.onClick();
                  onDismiss(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
