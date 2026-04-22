import { useState } from "react";
import { useFetchedImage } from "../hooks/useRemoteImage";
import { Modal } from "./ui/Modal";

interface LocalMediaModalProps {
  path: string;
  mediaType: "image" | "video";
  onClose: () => void;
}

function getFileName(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * Modal for viewing local media files (images and videos).
 * Fetches the file via the local-image API with proper auth handling.
 */
export function LocalMediaModal({
  path,
  mediaType,
  onClose,
}: LocalMediaModalProps) {
  const apiPath = `/api/local-image?path=${encodeURIComponent(path)}`;
  const { url, loading, error } = useFetchedImage(apiPath);
  const fileName = getFileName(path);

  return (
    <Modal title={fileName} onClose={onClose}>
      <div className="local-media-modal-content">
        {loading && <div className="local-media-loading">Loading...</div>}
        {error && <div className="local-media-error">{error}</div>}
        {url &&
          (mediaType === "video" ? (
            // biome-ignore lint/a11y/useMediaCaption: user-generated local files, no captions available
            <video controls autoPlay className="local-media-player" src={url} />
          ) : (
            <img className="local-media-image" src={url} alt={fileName} />
          ))}
      </div>
    </Modal>
  );
}

/**
 * Extract the original file path from a local-image API URL.
 */
function extractPathFromApiUrl(href: string): string | null {
  try {
    // href is like "/api/local-image?path=%2Ftmp%2Ffoo.mp4"
    const url = new URL(href, "http://localhost");
    return url.searchParams.get("path");
  } catch {
    return null;
  }
}

/**
 * Hook that provides a click handler for server-rendered HTML containing
 * .local-media-link elements. Returns modal state and the click handler.
 */
export function useLocalMediaClick() {
  const [modal, setModal] = useState<{
    path: string;
    mediaType: "image" | "video";
  } | null>(null);

  const handleClick = (e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest?.(
      "a.local-media-link",
    ) as HTMLAnchorElement | null;
    if (!target) return;

    e.preventDefault();
    e.stopPropagation();

    const href = target.getAttribute("href");
    if (!href) return;

    const path = extractPathFromApiUrl(href);
    if (!path) return;

    const mediaType =
      (target.getAttribute("data-media-type") as "image" | "video") ?? "image";
    setModal({ path, mediaType });
  };

  const closeModal = () => setModal(null);

  return { modal, handleClick, closeModal };
}
