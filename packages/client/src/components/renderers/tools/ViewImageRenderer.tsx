import { useState } from "react";
import { useFetchedImage } from "../../../hooks/useRemoteImage";
import { Modal } from "../../ui/Modal";
import type { ToolRenderer } from "./types";

interface ViewImageInput {
  path: string;
}

function getFileName(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * Modal content that fetches the image only when mounted (i.e. when modal opens).
 */
function ViewImageModalContent({ path, alt }: { path: string; alt: string }) {
  const apiPath = `/api/local-image?path=${encodeURIComponent(path)}`;
  const { url, loading, error } = useFetchedImage(apiPath);

  if (loading) {
    return (
      <div className="p-8 text-center text-[var(--text-muted)]">
        Loading image...
      </div>
    );
  }

  if (error || !url) {
    return (
      <div className="p-8 text-center text-[var(--error-color)]">
        {error ?? "Failed to load image"}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <img className="h-auto max-w-full rounded" src={url} alt={alt} />
    </div>
  );
}

/**
 * Clickable filename button that opens a modal to view the image.
 * Does NOT fetch anything until the modal is opened.
 */
function ViewImageButton({
  path,
  className,
  onClick,
}: {
  path: string;
  className: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button type="button" className={className} onClick={onClick}>
      {getFileName(path)}
      <span className="text-[0.85em] text-[var(--text-muted)] no-underline">
        (image)
      </span>
    </button>
  );
}

/**
 * Shared component: clickable filename + lazy-loading modal.
 */
function ViewImageClickable({
  path,
  buttonClass,
  stopPropagation,
}: {
  path: string;
  buttonClass: string;
  stopPropagation?: boolean;
}) {
  const [showModal, setShowModal] = useState(false);
  const fileName = getFileName(path);

  return (
    <>
      <ViewImageButton
        path={path}
        className={buttonClass}
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          setShowModal(true);
        }}
      />
      {showModal && (
        <Modal title={fileName} onClose={() => setShowModal(false)}>
          <ViewImageModalContent path={path} alt={fileName} />
        </Modal>
      )}
    </>
  );
}

export const viewImageRenderer: ToolRenderer<ViewImageInput, unknown> = {
  tool: "ViewImage",
  displayName: "View Image",

  renderToolUse(input, _context) {
    const { path } = input as ViewImageInput;
    return (
      <div className="flex flex-col gap-2">
        <ViewImageClickable
          path={path}
          buttonClass="inline-flex cursor-pointer items-center gap-3 rounded-lg border border-[var(--border-color)] bg-transparent px-3 py-2 text-left [font-family:var(--font-mono)] [font-size:var(--font-size-base)] text-[var(--link-color)] transition-colors duration-150 hover:border-[var(--border-input)] hover:bg-[var(--bg-hover)]"
        />
      </div>
    );
  },

  renderToolResult(_result, _isError, _context, input) {
    const { path } = input as ViewImageInput;
    return (
      <div className="flex flex-col gap-2">
        <ViewImageClickable
          path={path}
          buttonClass="inline-flex cursor-pointer items-center gap-3 rounded-lg border border-[var(--border-color)] bg-transparent px-3 py-2 text-left [font-family:var(--font-mono)] [font-size:var(--font-size-base)] text-[var(--link-color)] transition-colors duration-150 hover:border-[var(--border-input)] hover:bg-[var(--bg-hover)]"
        />
      </div>
    );
  },

  getUseSummary(input) {
    const path = (input as ViewImageInput)?.path ?? "";
    return getFileName(path);
  },

  getResultSummary(_result, isError) {
    return isError ? "Error" : "Image loaded";
  },

  renderInteractiveSummary(input, _result, _isError, _context) {
    const { path } = input as ViewImageInput;
    return (
      <ViewImageClickable
        path={path}
        buttonClass="inline-flex cursor-pointer items-center gap-2 bg-transparent p-0 [font-family:var(--font-mono)] text-inherit text-[var(--link-color)] underline decoration-transparent transition-colors duration-150 hover:decoration-current"
        stopPropagation
      />
    );
  },
};
