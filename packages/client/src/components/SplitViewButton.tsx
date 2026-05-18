import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useI18n } from "../i18n";
import { SplitSessionPicker } from "./SplitSessionPicker";

interface SplitViewButtonProps {
  currentSessionId: string;
}

export function SplitViewButton({ currentSessionId }: SplitViewButtonProps) {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const splitSessionId = searchParams.get("splitSession");
  const isSplitActive = !!splitSessionId;

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
        <SplitSessionPicker
          currentSessionId={currentSessionId}
          onSelect={handleOpenSplit}
          onClose={() => setIsOpen(false)}
          anchorRef={buttonRef}
        />
      )}
    </>
  );
}
