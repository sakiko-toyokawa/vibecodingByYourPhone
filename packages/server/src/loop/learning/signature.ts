/**
 * Failure signature rules — deterministic pre-aggregation for the learning
 * worker (设计决策: 去重/聚类先做确定性预聚合, 相同 failure tag + 相同错误
 * 指纹先进同一个桶, 不需要 AI; LLM 语义归并是后续可选增强).
 *
 * All normalization rules live in this one file so they are testable in
 * isolation (签名归一化规则集中一处). A signature is
 * `<failure_tag>:<normalized error shape>` — the tag buckets by attribution
 * vocabulary (失败模式账本.md 8 值), the normalized text is the error
 * "shape" with every volatile part (run ids, timestamps, paths, uuids,
 * hashes, durations, bare numbers) replaced by a stable placeholder, so the
 * same underlying failure reported from different runs / times / machines
 * lands in the same bucket.
 */

import { createHash } from "node:crypto";
import type { FailureTag } from "@yep-anywhere/shared";

/** Normalized fingerprint text is truncated to this length (取形, 不取全文). */
export const SIGNATURE_TEXT_LIMIT = 120;

/**
 * Replace the volatile parts of an error/reason text with stable
 * placeholders, then lowercase + collapse whitespace + truncate. Rules are
 * ordered: more specific patterns (timestamps, paths, ids) run before the
 * bare-number catch-all so they are not partially eaten first.
 */
export function normalizeErrorText(text: string): string {
  let out = text;
  // ISO dates / datetimes (2026-07-23, 2026-07-23T14:26:11.533Z, ...)
  out = out.replace(
    /\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?/g,
    "<ts>",
  );
  // Time-only (14:26:11.533)
  out = out.replace(/\b\d{2}:\d{2}:\d{2}(\.\d+)?\b/g, "<ts>");
  // UUIDs
  out = out.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    "<id>",
  );
  // run ids (run-1, run_001, runid variants emitted by control-plane ids)
  out = out.replace(/\brun[-_][\w-]+/gi, "<run>");
  // Windows absolute paths (C:\foo\bar, D:/x/y; 冒号只属盘符, 不进路径)
  out = out.replace(/\b[A-Za-z]:[\\/][^\s"':]+/g, "<path>");
  // POSIX absolute paths with >= 2 segments (/home/u/x, /tmp/a/b)
  out = out.replace(/\/[\w.@~+-]+(?:\/[\w.@~+-]+)+/g, "<path>");
  // Long hex hashes (commit sha, content hashes)
  out = out.replace(/\b[0-9a-f]{12,}\b/gi, "<hex>");
  // Durations (30000ms, 30 s, 2h)
  out = out.replace(/\b\d+(\.\d+)?\s?(ms|s|m|h)\b/gi, "<dur>");
  // Remaining bare numbers (line numbers, ports, pids, exit codes, ...)
  out = out.replace(/\b\d+\b/g, "<n>");
  // Shape: case- and whitespace-insensitive
  out = out.toLowerCase().replace(/\s+/g, " ").trim();
  return out.slice(0, SIGNATURE_TEXT_LIMIT);
}

/**
 * Cluster signature for one failure tag + evidence text. Empty / fully
 * volatile evidence still yields a stable bucket (`<no-evidence>`) so
 * tag-only events cluster together instead of exploding into one bucket
 * per event.
 */
export function buildSignature(tag: FailureTag, evidenceText: string): string {
  const normalized = normalizeErrorText(evidenceText);
  return `${tag}:${normalized.length > 0 ? normalized : "<no-evidence>"}`;
}

/** Short deterministic hash (id generation only, not security-sensitive). */
export function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** Deterministic pattern id — re-deriving it from the signature makes
 *  worker replays idempotent (cursor loss re-consumes safely). */
export function patternIdFor(signature: string): string {
  return `fp-${shortHash(signature)}`;
}

/** Deterministic proposal id per pattern — 去重靠它 (同 pattern 不重复建提案). */
export function proposalIdFor(patternId: string): string {
  return `prop-${shortHash(patternId)}`;
}
