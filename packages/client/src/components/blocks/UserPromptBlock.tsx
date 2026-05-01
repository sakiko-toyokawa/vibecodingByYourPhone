import { memo, useState } from "react";
import { useRemoteImage } from "../../hooks/useRemoteImage";
import {
  type UploadedFileInfo,
  getFilename,
  parseUserPrompt,
} from "../../lib/parseUserPrompt";
import type { ContentBlock } from "../../types";
import { Modal } from "../ui/Modal";

const MAX_LINES = 12;
const MAX_CHARS = MAX_LINES * 100;

interface Props {
  content: string | ContentBlock[];
}

interface InputImageBlock extends ContentBlock {
  type: "input_image";
  file_path?: string;
  image_url?: string;
  mime_type?: string;
}

/**
 * Renders file metadata (opened files) below the user prompt
 */
function OpenedFilesMetadata({ files }: { files: string[] }) {
  if (files.length === 0) return null;

  return (
    <div className="mt-1 mb-3 flex flex-wrap gap-2 pl-2 text-[10px] text-[var(--text-dimmed)]">
      {files.map((filePath) => (
        <span
          key={filePath}
          className="cursor-default"
          title={`file was opened in editor: ${filePath}`}
        >
          {getFilename(filePath)}
        </span>
      ))}
    </div>
  );
}

/**
 * Check if a MIME type is an image type
 */
function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/**
 * Extract URL components from an uploaded file path.
 * Path format: /.../.yep-anywhere/uploads/{projectId}/{sessionId}/{filename}
 */
function getUploadUrl(filePath: string): string | null {
  // Split path and get last 3 components: projectId, sessionId, filename
  const parts = filePath.split("/");
  if (parts.length < 3) return null;

  const filename = parts[parts.length - 1];
  const sessionId = parts[parts.length - 2];
  const projectId = parts[parts.length - 3];

  if (!filename || !sessionId || !projectId) return null;

  // Validate filename has UUID prefix
  if (!/^[0-9a-f-]{36}_/.test(filename)) return null;

  return `/api/projects/${projectId}/sessions/${sessionId}/upload/${encodeURIComponent(filename)}`;
}

function isInputImageBlock(block: ContentBlock): block is InputImageBlock {
  return block.type === "input_image";
}

function stripCodexImageMarkers(text: string): string {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "<image>")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseInlineImageData(imageUrl: string): {
  mimeType?: string;
  bytes?: number;
} {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(imageUrl);
  if (!match) return {};

  const rawMime = match[1]?.trim();
  const mimeType = rawMime || undefined;
  const isBase64 = Boolean(match[2]);
  const payload = (match[3] ?? "").trim();
  if (!payload) return { mimeType };

  if (!isBase64) {
    const decoded = decodeURIComponent(payload);
    return { mimeType, bytes: decoded.length };
  }

  const sanitized = payload.replace(/\s+/g, "");
  const padding = sanitized.endsWith("==")
    ? 2
    : sanitized.endsWith("=")
      ? 1
      : 0;
  const bytes = Math.max(0, Math.floor((sanitized.length * 3) / 4) - padding);
  return { mimeType, bytes };
}

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getMimeTypeFromPath(path: string): string | undefined {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith(".png")) return "image/png";
  if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg"))
    return "image/jpeg";
  if (lowerPath.endsWith(".gif")) return "image/gif";
  if (lowerPath.endsWith(".webp")) return "image/webp";
  if (lowerPath.endsWith(".bmp")) return "image/bmp";
  if (lowerPath.endsWith(".svg")) return "image/svg+xml";
  return undefined;
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/svg+xml") return "svg";
  const slashIndex = normalized.indexOf("/");
  if (slashIndex === -1) return "png";
  const ext = normalized.slice(slashIndex + 1);
  return ext || "png";
}

function filenameFromUrl(imageUrl: string): string | null {
  if (imageUrl.startsWith("data:")) return null;

  try {
    const parsed = new URL(imageUrl, "https://codex.local");
    const pathname = parsed.pathname || "";
    const segment = pathname.split("/").filter(Boolean).pop();
    return segment ? decodeURIComponent(segment) : null;
  } catch {
    return null;
  }
}

function extractCodexImageFiles(content: ContentBlock[]): UploadedFileInfo[] {
  const files: UploadedFileInfo[] = [];
  let imageIndex = 0;

  for (const block of content) {
    if (!isInputImageBlock(block)) continue;
    imageIndex += 1;

    const filePath =
      typeof block.file_path === "string" ? block.file_path.trim() : "";
    const imageUrl =
      typeof block.image_url === "string" ? block.image_url.trim() : "";
    const inlineData = imageUrl ? parseInlineImageData(imageUrl) : {};

    const mimeType =
      (typeof block.mime_type === "string" && block.mime_type.trim()) ||
      inlineData.mimeType ||
      (filePath ? getMimeTypeFromPath(filePath) : undefined) ||
      (imageUrl ? getMimeTypeFromPath(imageUrl) : undefined) ||
      "image/*";

    const fileName =
      (filePath && getFilename(filePath)) ||
      (imageUrl && filenameFromUrl(imageUrl)) ||
      `pasted-image-${imageIndex}.${extensionForMimeType(mimeType)}`;

    const path =
      filePath ||
      (imageUrl && !imageUrl.startsWith("data:") ? imageUrl : "") ||
      `codex-inline://image/${imageIndex}`;

    files.push({
      originalName: fileName,
      size: formatFileSize(inlineData.bytes),
      mimeType,
      path,
      previewUrl: imageUrl || undefined,
    });
  }

  return files;
}

function mergeUploadedFiles(
  primary: UploadedFileInfo[],
  secondary: UploadedFileInfo[],
): UploadedFileInfo[] {
  const seen = new Set<string>();
  const merged: UploadedFileInfo[] = [];

  for (const file of [...primary, ...secondary]) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    merged.push(file);
  }

  return merged;
}

/**
 * Single uploaded file attachment - clickable for images
 */
function UploadedFileItem({ file }: { file: UploadedFileInfo }) {
  const [showModal, setShowModal] = useState(false);
  const isImage = isImageMimeType(file.mimeType);
  const apiPath = isImage ? getUploadUrl(file.path) : null;
  const directPreviewUrl = isImage ? (file.previewUrl ?? null) : null;

  // Use the remote image hook to handle fetching via relay when needed
  const { url: remoteImageUrl, loading, error } = useRemoteImage(apiPath);
  const imageUrl = directPreviewUrl ?? remoteImageUrl;

  if (isImage && (apiPath || directPreviewUrl)) {
    return (
      <>
        <button
          type="button"
          className="cursor-pointer bg-transparent p-0 font-inherit text-[var(--link-color)] hover:underline"
          title={`${file.mimeType}, ${file.size}`}
          onClick={() => setShowModal(true)}
        >
          📎 {file.originalName}
        </button>
        {showModal && (
          <Modal title={file.originalName} onClose={() => setShowModal(false)}>
            <div className="flex items-center justify-center p-2">
              {apiPath && loading && (
                <div className="text-sm text-[var(--text-dimmed)]">
                  Loading...
                </div>
              )}
              {apiPath && error && (
                <div className="text-sm text-[var(--error-color)]">
                  Failed to load image
                </div>
              )}
              {imageUrl && (
                <img
                  src={imageUrl}
                  alt={file.originalName}
                  className="max-h-[70vh] max-w-full rounded-md object-contain"
                />
              )}
            </div>
          </Modal>
        )}
      </>
    );
  }

  return (
    <span
      className="cursor-default text-[var(--text-secondary)]"
      title={`${file.mimeType}, ${file.size}`}
    >
      📎 {file.originalName}
    </span>
  );
}

/**
 * Renders uploaded file attachments below the user prompt
 */
function UploadedFilesMetadata({ files }: { files: UploadedFileInfo[] }) {
  if (files.length === 0) return null;

  return (
    <div className="mt-1 mb-3 flex flex-wrap gap-2 pl-2 text-[10px] text-[var(--text-dimmed)]">
      {files.map((file) => (
        <UploadedFileItem key={file.path} file={file} />
      ))}
    </div>
  );
}

/**
 * Renders text content with optional truncation and "Show more" button
 */
function CollapsibleText({ text }: { text: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const lines = text.split("\n");
  const exceedsLines = lines.length > MAX_LINES;
  const exceedsChars = text.length > MAX_CHARS;
  const needsTruncation = exceedsLines || exceedsChars;

  if (!needsTruncation || isExpanded) {
    return (
      <div className="whitespace-pre-wrap break-words">
        {text}
        {isExpanded && needsTruncation && (
          <button
            type="button"
            className="ml-auto mt-1 block cursor-pointer rounded border border-[var(--border-color)] bg-transparent px-2 py-0.5 text-xs text-[var(--text-dimmed)] transition-colors duration-150 hover:border-[var(--text-dimmed)] hover:text-[var(--text-primary)]"
            onClick={() => setIsExpanded(false)}
          >
            Show less
          </button>
        )}
      </div>
    );
  }

  // Truncate by lines first, then by characters if still too long
  let truncatedText = exceedsLines
    ? lines.slice(0, MAX_LINES).join("\n")
    : text;
  if (truncatedText.length > MAX_CHARS) {
    truncatedText = truncatedText.slice(0, MAX_CHARS);
  }

  return (
    <div className="relative">
      <div className="relative whitespace-pre-wrap break-words">
        {truncatedText}
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-[2.5em] bg-gradient-to-b from-transparent to-[var(--bg-user-message)]" />
      </div>
      <button
        type="button"
        className="ml-auto mt-1 block cursor-pointer rounded border border-[var(--border-color)] bg-transparent px-2 py-0.5 text-xs text-[var(--text-dimmed)] transition-colors duration-150 hover:border-[var(--text-dimmed)] hover:text-[var(--text-primary)]"
        onClick={() => setIsExpanded(true)}
      >
        Show more
      </button>
    </div>
  );
}

export const UserPromptBlock = memo(function UserPromptBlock({
  content,
}: Props) {
  if (typeof content === "string") {
    const { text, openedFiles, uploadedFiles } = parseUserPrompt(content);

    // Don't render if there's no actual text content
    if (!text) {
      const hasMetadata = openedFiles.length > 0 || uploadedFiles.length > 0;
      return hasMetadata ? (
        <>
          <UploadedFilesMetadata files={uploadedFiles} />
          <OpenedFilesMetadata files={openedFiles} />
        </>
      ) : null;
    }

    return (
      <div className="mb-4">
        <div className="w-fit max-w-[80%] rounded-md bg-[var(--bg-user-message)] px-2 py-1 text-[13px]">
          <div className="whitespace-pre-wrap break-words">
            <CollapsibleText text={text} />
            <UploadedFilesMetadata files={uploadedFiles} />
          </div>
        </div>
        <OpenedFilesMetadata files={openedFiles} />
      </div>
    );
  }

  // Array content - extract text blocks for display
  const textContent = content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n");
  const codexImageFiles = extractCodexImageFiles(content);
  const textForParsing =
    codexImageFiles.length > 0
      ? stripCodexImageMarkers(textContent)
      : textContent;

  // Parse the combined text content for metadata
  const { text, openedFiles, uploadedFiles } = parseUserPrompt(textForParsing);
  const allUploadedFiles = mergeUploadedFiles(uploadedFiles, codexImageFiles);

  if (!text) {
    const hasMetadata = openedFiles.length > 0 || allUploadedFiles.length > 0;
    return hasMetadata ? (
      <>
        <UploadedFilesMetadata files={allUploadedFiles} />
        <OpenedFilesMetadata files={openedFiles} />
      </>
    ) : (
      <div className="w-fit max-w-[80%] rounded-md bg-[var(--bg-user-message)] px-2 py-1 text-[13px]">
        <div className="whitespace-pre-wrap break-words">
          <div className="whitespace-pre-wrap break-words">
            [Complex content]
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4">
      <div className="w-fit max-w-[80%] rounded-md bg-[var(--bg-user-message)] px-2 py-1 text-[13px]">
        <div className="whitespace-pre-wrap break-words">
          <CollapsibleText text={text} />
          <UploadedFilesMetadata files={allUploadedFiles} />
        </div>
      </div>
      <OpenedFilesMetadata files={openedFiles} />
    </div>
  );
});
