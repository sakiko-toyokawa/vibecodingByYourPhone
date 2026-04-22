/**
 * JSONL file reading utilities.
 *
 * Shared helpers for reading JSONL session files with BOM handling
 * and partial reads (to avoid loading multi-MB files entirely).
 */

import { open, readFile } from "node:fs/promises";

/** Strip UTF-8 BOM if present (common on Windows). */
export function stripBom(str: string): string {
  return str.charCodeAt(0) === 0xfeff ? str.slice(1) : str;
}

/**
 * Read the first line of a file using a partial read.
 * Reads in chunks until it finds a newline, reaches EOF, or hits maxBytes.
 * Returns null for empty files or empty first lines.
 */
export async function readFirstLine(
  filePath: string,
  maxBytes = 4096,
): Promise<string | null> {
  let fd: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fd = await open(filePath, "r");
    const chunkSize = Math.min(4096, maxBytes);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let content = "";

    while (totalBytes < maxBytes) {
      const remaining = maxBytes - totalBytes;
      const buf = Buffer.alloc(Math.min(chunkSize, remaining));
      const { bytesRead } = await fd.read(buf, 0, buf.length, totalBytes);
      if (bytesRead === 0) break;

      chunks.push(buf.subarray(0, bytesRead));
      totalBytes += bytesRead;
      content = Buffer.concat(chunks).toString("utf-8");
      if (content.includes("\n")) break;
    }

    if (totalBytes === 0) return null;

    const stripped = stripBom(content);
    const nl = stripped.indexOf("\n");
    const line = (nl > 0 ? stripped.slice(0, nl) : stripped).trim();
    return line || null;
  } catch {
    return null;
  } finally {
    await fd?.close();
  }
}

/**
 * Read a file and return BOM-stripped lines.
 */
export async function readJsonlLines(filePath: string): Promise<string[]> {
  const raw = await readFile(filePath, "utf-8");
  return stripBom(raw).trim().split("\n");
}
