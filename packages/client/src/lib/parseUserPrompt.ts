import {
  parseOpenedFiles,
  getFilename as sharedGetFilename,
  stripIdeMetadata,
} from "@yep-anywhere/shared";

/**
 * Uploaded file attachment metadata
 */
export interface UploadedFileInfo {
  originalName: string;
  size: string;
  mimeType: string;
  path: string;
  /** Optional direct preview URL for inline provider attachments (e.g. data: URLs) */
  previewUrl?: string;
}

/**
 * Parsed user prompt with metadata extracted
 */
export interface ParsedUserPrompt {
  /** The actual user message text (without metadata tags) */
  text: string;
  /** Full paths of files the user had open in their IDE */
  openedFiles: string[];
  /** Uploaded file attachments */
  uploadedFiles: UploadedFileInfo[];
}

/**
 * Extracts the filename from a full file path.
 * Re-exported from shared for backward compatibility.
 */
export const getFilename = sharedGetFilename;

/**
 * Parse the "User uploaded files:" section from message content.
 * Format: "- filename (size, mimetype): path"
 */
function parseUploadedFiles(content: string): {
  textWithoutUploads: string;
  uploadedFiles: UploadedFileInfo[];
} {
  const uploadedFiles: UploadedFileInfo[] = [];

  // Match the "User uploaded files:" section
  const uploadMarker = "\n\nUser uploaded files:\n";
  const markerIndex = content.indexOf(uploadMarker);

  if (markerIndex === -1) {
    return { textWithoutUploads: content, uploadedFiles: [] };
  }

  const textWithoutUploads = content.slice(0, markerIndex);
  const uploadSection = content.slice(markerIndex + uploadMarker.length);

  // Parse each line: "- filename (size, mimetype): path"
  const lineRegex = /^- (.+?) \(([^,]+), ([^)]+)\): (.+)$/;
  for (const line of uploadSection.split("\n")) {
    const match = line.match(lineRegex);
    if (match) {
      uploadedFiles.push({
        originalName: match[1] ?? "",
        size: match[2] ?? "",
        mimeType: match[3] ?? "",
        path: match[4] ?? "",
      });
    }
  }

  return { textWithoutUploads, uploadedFiles };
}

/**
 * Parses user prompt content, extracting ide_opened_file metadata tags
 * and "User uploaded files:" sections.
 * Returns the cleaned text, list of opened file paths, and uploaded files.
 *
 * Also handles <ide_selection> tags by stripping them from the text.
 */
export function parseUserPrompt(content: string): ParsedUserPrompt {
  // First extract uploaded files section
  const { textWithoutUploads, uploadedFiles } = parseUploadedFiles(content);

  // Then process IDE metadata on the remaining text
  return {
    text: stripIdeMetadata(textWithoutUploads),
    openedFiles: parseOpenedFiles(textWithoutUploads),
    uploadedFiles,
  };
}
