/** GitHub-specific feedback author filtering for polling and webhook adapters. */
const KNOWN_BOT_LOGINS = new Set([
  "claassistant",
  "github-actions",
  "dependabot",
  "renovate",
  "google-cla",
  "copilot",
]);

export function isExternalFeedbackAuthor(
  author: string | null | undefined,
  selfLogin?: string | null,
): boolean {
  if (!author) return true;
  const normalized = author.trim().toLowerCase();
  if (!normalized) return true;
  if (selfLogin && normalized === selfLogin.trim().toLowerCase()) return false;
  const base = normalized.replace(/\[bot\]$/, "");
  return base === normalized && !KNOWN_BOT_LOGINS.has(base);
}
