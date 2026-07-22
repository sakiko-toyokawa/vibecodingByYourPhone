/**
 * Unified adapter error type (spec: docs/spec/02-schema契约.md §4
 * "AdapterOutput 与统一错误码"; phased plan: 05-分阶段计划.md 阶段 1
 * "adapter 统一错误码与超时").
 *
 * Both providers (Claude SDK / Codex app-server) surface failures in
 * provider-specific shapes; the loop layer needs a single vocabulary to
 * attribute failures. `AdapterError.code` is the §4 seven-value enum;
 * `toAdapterError()` normalizes raw provider errors into it.
 *
 * Failure-attribution mapping (失败模式账本.md authoritative vocabulary)
 * lives in `adapterErrorCodeToFailureTag` — the loop run service writes it
 * into the decision ledger when an adapter hard error terminates a run.
 *
 * Interactive-session compatibility: `AdapterError` extends `Error` and
 * always preserves the original message, so existing error-display paths
 * (which read `error.message`) are unaffected. AbortError is deliberately
 * NOT mapped here — it is a user-initiated interrupt, callers must keep
 * the existing silent-abort handling and never route it through
 * `toAdapterError`.
 */

/** §4 统一错误码枚举（判定标准见 spec 表格）。 */
export const ADAPTER_ERROR_CODES = [
  "timeout",
  "spawn_failed",
  "stream_broken",
  "permission_denied",
  "resume_failed",
  "capability_unavailable",
  "unknown",
] as const;
export type AdapterErrorCode = (typeof ADAPTER_ERROR_CODES)[number];

/** 失败模式账本.md 的失败归因词汇（与 shared FailureTagSchema 同枚举）。 */
export type AdapterFailureTag =
  | "intent_error"
  | "runtime_blackbox_error"
  | "context_error"
  | "memory_packet_error"
  | "tool_error"
  | "policy_error"
  | "verification_error"
  | "eval_regression";

export interface AdapterErrorContext {
  /** Human-readable operation label (e.g. "turn/start", "claude query"). */
  operation?: string;
  /** True when the failing call was resuming an existing session/thread. */
  resumeAttempted?: boolean;
}

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  /** Phase-2 retry policy hint: transient infra errors are retryable. */
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(
    code: AdapterErrorCode,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[code];
    this.cause = options.cause;
  }
}

const DEFAULT_RETRYABLE: Record<AdapterErrorCode, boolean> = {
  // 超时 / 连接未建立 / 流中断是瞬态基础设施故障，重试可能成功
  timeout: true,
  spawn_failed: true,
  stream_broken: true,
  // 权限拒绝、resume 失效、能力缺口、未知错误重试无意义（同样输入同样失败）
  permission_denied: false,
  resume_failed: false,
  capability_unavailable: false,
  unknown: false,
};

export function isAdapterError(error: unknown): error is AdapterError {
  return error instanceof AdapterError;
}

/**
 * §4 错误码 → 失败模式账本归因词汇。
 *
 * - timeout / spawn_failed / stream_broken / resume_failed / unknown：
 *   runtime（Claude Code / Codex）自身或桥接层不可恢复 —— 账本语义
 *   `runtime_blackbox_error`（"内部行为不可解释或不可恢复"）。`tool_error`
 *   指 runtime *内部* 工具调用失败或无法观测，adapter 调用层的失败不在其列。
 * - permission_denied：外层策略拒绝了必需权限 → `policy_error`。
 * - capability_unavailable：本轮需要的能力（如 structured events）不在
 *   adapter 能力矩阵内，执行无法被观测 → `tool_error`（"无法观测"分支）。
 */
export function adapterErrorCodeToFailureTag(
  code: AdapterErrorCode,
): AdapterFailureTag {
  switch (code) {
    case "permission_denied":
      return "policy_error";
    case "capability_unavailable":
      return "tool_error";
    default:
      return "runtime_blackbox_error";
  }
}

/**
 * Normalize a raw provider-side error into an AdapterError.
 *
 * Already-normalized errors pass through unchanged. The original message is
 * always preserved (interactive display compatibility); classification is
 * best-effort by message shape, falling back to `unknown` (§4: 入账本时必须
 * 附 error.message — the message is right there).
 *
 * NOTE: callers must filter AbortError before calling this — user-initiated
 * aborts are not failures and keep their existing silent semantics.
 */
export function toAdapterError(
  error: unknown,
  context: AdapterErrorContext = {},
): AdapterError {
  if (error instanceof AdapterError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const cause = error instanceof Error ? error : undefined;
  const wrap = (code: AdapterErrorCode) =>
    new AdapterError(code, message, { cause });

  // §4 判定：调用超过 timeout_seconds 未完成
  if (/timed?\s?out|timeout|deadline exceeded/.test(lower)) {
    return wrap("timeout");
  }
  // §4 判定：resume_token / resume_ref 失效。resume 语义优先于 spawn
  // （"No conversation found..." 之类的 resume 失败可能同时含 "not found"）。
  if (
    context.resumeAttempted ||
    /resume|no conversation found|session not found/.test(lower)
  ) {
    if (/resume|conversation|session/.test(lower)) {
      return wrap("resume_failed");
    }
  }
  // §4 判定：子进程 / SDK 调用 / 连接未能建立（命令不存在、连接被拒、握手失败）
  if (
    /spawn|enoent|executable not found|command not found|not installed|econnrefused|connection refused|handshake/.test(
      lower,
    )
  ) {
    return wrap("spawn_failed");
  }
  // §4 判定：runtime 或外层策略拒绝了必需权限 / 审批
  if (/permission denied|eacces|not permitted|approval denied/.test(lower)) {
    return wrap("permission_denied");
  }
  // §4 判定：本轮需要的能力不在 adapter 能力矩阵内
  if (/capability|unsupported|not supported/.test(lower)) {
    return wrap("capability_unavailable");
  }
  // §4 判定：调用已建立但结构化事件流中途断开
  if (
    /stream|broken pipe|econnreset|socket hang up|connection (closed|lost|reset)/.test(
      lower,
    )
  ) {
    return wrap("stream_broken");
  }
  // §4 兜底
  return wrap("unknown");
}
