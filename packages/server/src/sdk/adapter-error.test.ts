import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADAPTER_ERROR_CODES,
  AdapterError,
  adapterErrorCodeToFailureTag,
  toAdapterError,
} from "./adapter-error.js";

// 02-schema契约.md §4 统一错误码七枚举的映射覆盖。

test("ADAPTER_ERROR_CODES is exactly the 02 §4 seven-value enum", () => {
  assert.deepEqual(
    [...ADAPTER_ERROR_CODES],
    [
      "timeout",
      "spawn_failed",
      "stream_broken",
      "permission_denied",
      "resume_failed",
      "capability_unavailable",
      "unknown",
    ],
  );
});

test("toAdapterError maps timeout-shaped errors to code=timeout", () => {
  const err = toAdapterError(new Error("Codex app-server request timed out"));
  assert.equal(err.code, "timeout");
  assert.equal(err.retryable, true);
});

test("toAdapterError maps spawn/ENOENT errors to code=spawn_failed", () => {
  const err = toAdapterError(
    new Error("Failed to spawn Claude Code process: spawn claude ENOENT"),
  );
  assert.equal(err.code, "spawn_failed");
  assert.equal(err.retryable, true);
  // 原始 message 保留（交互会话错误展示路径读 error.message）
  assert.match(err.message, /spawn claude ENOENT/);
});

test("toAdapterError maps mid-call stream failures to code=stream_broken", () => {
  const err = toAdapterError(new Error("stream connection reset by peer"));
  assert.equal(err.code, "stream_broken");
});

test("toAdapterError maps permission refusals to code=permission_denied", () => {
  const err = toAdapterError(
    new Error("EACCES: permission denied, open '/etc/x'"),
  );
  assert.equal(err.code, "permission_denied");
  assert.equal(err.retryable, false);
});

test("toAdapterError maps invalid resume tokens to code=resume_failed", () => {
  const err = toAdapterError(
    new Error("No conversation found with session ID abc"),
    { resumeAttempted: true },
  );
  assert.equal(err.code, "resume_failed");
});

test("toAdapterError maps missing capabilities to code=capability_unavailable", () => {
  const err = toAdapterError(
    new Error("structured events capability not supported by this adapter"),
  );
  assert.equal(err.code, "capability_unavailable");
});

test("toAdapterError falls back to code=unknown with the original message", () => {
  const err = toAdapterError(new Error("something genuinely weird happened"));
  assert.equal(err.code, "unknown");
  assert.equal(err.message, "something genuinely weird happened");
});

test("toAdapterError passes AdapterError through unchanged", () => {
  const original = new AdapterError("timeout", "already normalized");
  assert.equal(toAdapterError(original), original);
});

test("toAdapterError handles non-Error values", () => {
  const err = toAdapterError("plain string failure");
  assert.equal(err.code, "unknown");
  assert.equal(err.message, "plain string failure");
});

test("failure attribution: timeout → runtime_blackbox_error (失败模式账本)", () => {
  // 失败模式账本.md：tool_error 指 runtime *内部* 工具调用失败；adapter
  // 调用层超时是 runtime / 桥接层整体不可恢复 → runtime_blackbox_error。
  assert.equal(
    adapterErrorCodeToFailureTag("timeout"),
    "runtime_blackbox_error",
  );
  assert.equal(
    adapterErrorCodeToFailureTag("spawn_failed"),
    "runtime_blackbox_error",
  );
  assert.equal(
    adapterErrorCodeToFailureTag("stream_broken"),
    "runtime_blackbox_error",
  );
  assert.equal(
    adapterErrorCodeToFailureTag("resume_failed"),
    "runtime_blackbox_error",
  );
  assert.equal(
    adapterErrorCodeToFailureTag("unknown"),
    "runtime_blackbox_error",
  );
  assert.equal(
    adapterErrorCodeToFailureTag("permission_denied"),
    "policy_error",
  );
  assert.equal(
    adapterErrorCodeToFailureTag("capability_unavailable"),
    "tool_error",
  );
});
