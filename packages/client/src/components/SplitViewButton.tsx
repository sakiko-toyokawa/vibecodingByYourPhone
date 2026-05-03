import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useGlobalSessions } from "../hooks/useGlobalSessions";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";

interface SplitViewButtonProps {
  currentSessionId: string;
}

export function SplitViewButton({ currentSessionId }: SplitViewButtonProps) {
  const { t } = useI18n();
  const basePath = useRemoteBasePath();
  const [searchParams, setSearchParams] = useSearchParams();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const splitSessionId = searchParams.get("splitSession");
  const isSplitActive = !!splitSessionId;

  const { sessions } = useGlobalSessions({
    limit: 20,
    includeStats: false,
  });

  const availableSessions = sessions.filter(
    (s) => s.id !== currentSessionId && !s.isArchived,
  );

  const handleOpenSplit = (sessionId: string, projectId: string) => {
    const newParams = new URLSearchParams(searchParams);
    newParams.set("splitSession", sessionId);
    newParams.set("splitProject", projectId);
    setSearchParams(newParams, { replace: true });
    setIsOpen(false);
  };

  const handleCloseSplit = () => {
    const newParams = new URLSearchParams(searchParams);
    newParams.delete("splitSession");
    newParams.delete("splitProject");
    setSearchParams(newParams, { replace: true });
  };

  const handleBackdropKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
      setIsOpen(false);
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-transparent p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        onClick={() => {
          if (isSplitActive) {
            handleCloseSplit();
          } else {
            setIsOpen(!isOpen);
          }
        }}
        title={isSplitActive ? t("sessionCloseSplit") : t("sessionSplitView")}
        aria-label={
          isSplitActive ? t("sessionCloseSplit") : t("sessionSplitView")
        }
      >
        <span className="text-sm font-medium">
          {isSplitActive ? "❌" : "◫"}
        </span>
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-[10000]"
          onClick={() => setIsOpen(false)}
          onKeyDown={handleBackdropKeyDown}
          role="button"
          tabIndex={0}
          aria-label={t("actionBack")}
        >
          <div
            ref={(el) => {
              if (el) {
                const rect = buttonRef.current?.getBoundingClientRect();
                if (rect) {
                  el.style.top = `${rect.bottom + 4}px`;
                  el.style.right = `${window.innerWidth - rect.right}px`;
                }
              }
            }}
            className="absolute z-[10001] min-w-[280px] max-w-[400px] overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-color)] bg-[var(--bg-surface)] shadow-[0_4px_16px_rgba(0,0,0,0.4)]"
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
                    onClick={() =>
                      handleOpenSplit(session.id, session.projectId)
                    }
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
      )}
    </>
  );
}
