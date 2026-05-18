import { useLayoutEffect, useRef, useState } from "react";
import { useGlobalSessions } from "../hooks/useGlobalSessions";
import { useI18n } from "../i18n";

interface SplitSessionPickerProps {
  currentSessionId: string;
  onSelect: (sessionId: string, projectId: string) => void;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}

export function SplitSessionPicker({
  currentSessionId,
  onSelect,
  onClose,
  anchorRef,
}: SplitSessionPickerProps) {
  const { t } = useI18n();
  const { sessions } = useGlobalSessions({
    limit: 20,
    includeStats: false,
  });
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<
    React.CSSProperties | undefined
  >();

  const availableSessions = sessions.filter(
    (s) => s.id !== currentSessionId && !s.isArchived,
  );

  useLayoutEffect(() => {
    if (anchorRef?.current && panelRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setPanelStyle({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    }
  }, [anchorRef]);

  const handleBackdropKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[10000]"
      onClick={onClose}
      onKeyDown={handleBackdropKeyDown}
      role="button"
      tabIndex={0}
      aria-label={t("actionBack")}
    >
      <div
        ref={panelRef}
        className="absolute z-[10001] min-w-[280px] max-w-[400px] overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-color)] bg-[var(--bg-surface)] shadow-[0_4px_16px_rgba(0,0,0,0.4)]"
        style={panelStyle ?? { top: 60, right: 16 }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="presentation"
      >
        <div className="border-b border-[var(--border-color)] px-3 py-2 text-[var(--text-muted)] [font-size:var(--font-size-xs)] font-semibold uppercase tracking-wider">
          {t("sessionSelectForSplit")}
        </div>
        {availableSessions.length === 0 ? (
          <div className="px-3 py-4 text-[var(--text-muted)] [font-size:var(--font-size-sm)]">
            {t("sidebarNoSessions")}
          </div>
        ) : (
          <div className="max-h-[400px] overflow-y-auto">
            {availableSessions.map((session) => (
              <button
                key={session.id}
                type="button"
                className="flex w-full items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-3 py-2.5 text-left text-[var(--text-primary)] transition-colors duration-100 hover:bg-[var(--bg-hover)] active:bg-[var(--bg-active)]"
                onClick={() => onSelect(session.id, session.projectId)}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 [font-size:var(--font-size-sm)] font-normal text-[var(--text-secondary)] min-w-0">
                    {session.isStarred && (
                      <span className="text-[var(--accent-star)] shrink-0 text-xs">
                        &#x2605;
                      </span>
                    )}
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                      {session.customTitle || session.title || "Untitled"}
                    </span>
                  </span>
                  <span className="[font-size:var(--font-size-xs)] text-[var(--text-muted)] overflow-hidden text-ellipsis whitespace-nowrap">
                    {session.projectName}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
