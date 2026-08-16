/**
 * 反馈作者过滤：只有「外部人类」的评论/评审才算维护反馈。
 *
 * 2026-08-15 生产审计发现两类脏反馈：
 * - CLAassistant、google-cla[bot] 这类 bot/App 的留言被当成维护者回应，
 *   白白消耗 repair_count 并触发无效修复 run；
 * - 系统自己账号发的评论（比如 approve-issue 发布的分析）会被 poller
 *   捡回来当成新反馈，形成自我唤醒。
 */

/** 已知非人类来源（GitHub App 登录名通常不带 [bot] 后缀，需显式列出）。 */
const KNOWN_BOT_LOGINS = new Set([
  "claassistant",
  "github-actions",
  "dependabot",
  "renovate",
  "google-cla",
  "copilot",
]);

/**
 * author 为 null（API 未给作者）时按外部处理——宁可多唤醒一次，
 * 也不静默丢真实维护者反馈。
 */
export function isExternalFeedbackAuthor(
  author: string | null | undefined,
  selfLogin?: string | null,
): boolean {
  if (!author) {
    return true;
  }
  const normalized = author.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (selfLogin && normalized === selfLogin.trim().toLowerCase()) {
    return false;
  }
  const base = normalized.replace(/\[bot\]$/, "");
  if (base !== normalized || KNOWN_BOT_LOGINS.has(base)) {
    return false;
  }
  return true;
}
