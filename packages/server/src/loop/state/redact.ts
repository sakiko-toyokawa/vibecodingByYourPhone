/**
 * Sensitive-data redaction for human-facing projections.
 *
 * Raw run state / ledger remain the source of truth. This utility is applied
 * at projection boundaries (STATE.md and human_report.md) so API keys and
 * absolute workspace paths do not leak into human-readable files.
 */

import { sha256Hex } from "../../utils/checksum.js";

const SECRET_ASSIGNMENT =
  /\b(api[_-]?key|secret|token|password|passwd|private[_-]?key|access[_-]?key)\s*[:=]\s*["']?([^"'\s,;}]+)/gi;
const TOKEN_PREFIX =
  /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

/** Replace a known workspace root and common absolute-path prefixes. */
export function redactAbsolutePaths(
  text: string,
  workspacePath?: string,
): string {
  let result = text;
  if (workspacePath) {
    const normalized = workspacePath.replace(/[\\/]+$/, "");
    result = result.split(normalized).join("{workspace}");
  }
  return result
    .replace(/[A-Za-z]:[\\/][^\s"<>|?*]+/g, "{abs-path}")
    .replace(/\/home\/[^\s"<>|?*]+/g, "{abs-path}")
    .replace(/\/Users\/[^\s"<>|?*]+/g, "{abs-path}")
    .replace(/\/private\/[^\s"<>|?*]+/g, "{abs-path}")
    .replace(/\/tmp\/[^\s"<>|?*]+/g, "{abs-path}")
    .replace(/\/var\/[^\s"<>|?*]+/g, "{abs-path}");
}

/** Replace secret-looking values and private key blocks. */
export function redactSecrets(text: string): string {
  return text
    .replace(PRIVATE_KEY_BLOCK, "[REDACTED:private_key]")
    .replace(
      SECRET_ASSIGNMENT,
      (_match, name: string, _value: string) =>
        `env:${String(name)
          .replace(/[^a-zA-Z0-9]/g, "_")
          .toLowerCase()}`,
    )
    .replace(TOKEN_PREFIX, "[REDACTED:token]");
}

export function redactForHumanReport(
  text: string,
  workspacePath?: string,
): string {
  return redactSecrets(redactAbsolutePaths(text, workspacePath));
}

/** Replace large content with a stable hash so reports stay small. */
export function hashLargeContent(content: string, maxChars = 2000): string {
  if (content.length <= maxChars) {
    return content;
  }
  return `sha256:${sha256Hex(content)}`;
}
