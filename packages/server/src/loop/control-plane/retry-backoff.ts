/**
 * Retry 退避（阶段 2）：指数退避 1min × 2^(n-1)，上限 5min。
 *
 * n 是第几次 retry（1 起，等于 budget.used_retries 的递增值）：
 *   第 1 次 retry 等 1min，第 2 次 2min，第 3 次 4min，第 4 次起封顶 5min。
 *
 * 阶段 2 的简化（05：重试退避可配上限）：退避参数是本模块常量，不进
 * LoopCard / 合约；如需可调，后续阶段再投影到配置。
 */

export const RETRY_BACKOFF_BASE_MS = 60_000;
export const RETRY_BACKOFF_CAP_MS = 300_000;

export function retryBackoffMs(retryNumber: number): number {
  if (retryNumber < 1) {
    return RETRY_BACKOFF_BASE_MS;
  }
  const backoff = RETRY_BACKOFF_BASE_MS * 2 ** (retryNumber - 1);
  return Math.min(backoff, RETRY_BACKOFF_CAP_MS);
}
