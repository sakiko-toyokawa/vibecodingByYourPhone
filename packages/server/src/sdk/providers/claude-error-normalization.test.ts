import assert from "node:assert/strict";
import { test } from "node:test";
import { AdapterError } from "../adapter-error.js";
import { normalizeClaudeStartError } from "./claude.js";

/**
 * Claude provider error normalization (02-schema契约.md §4): spawn failures
 * → spawn_failed, resume failures → resume_failed, everything else flows
 * through toAdapterError. Friendly messages are preserved so interactive
 * error display is unchanged.
 */

test("simulated spawn failure → AdapterError code=spawn_failed with friendly message", () => {
  const raw = new Error("spawn claude ENOENT");
  const err = normalizeClaudeStartError(raw);
  assert.ok(err instanceof AdapterError);
  assert.equal(err.code, "spawn_failed");
  assert.match(err.message, /Failed to spawn Claude CLI process/);
  assert.match(err.message, /spawn claude ENOENT/);
  assert.equal(err.cause, raw);
});

test("CLI executable missing → spawn_failed with the install hint (unchanged text)", () => {
  const err = normalizeClaudeStartError(
    new Error("Claude Code executable not found"),
  );
  assert.ok(err instanceof AdapterError);
  assert.equal(err.code, "spawn_failed");
  assert.equal(
    err.message,
    "Claude CLI not installed. Run: curl -fsSL https://claude.ai/install.sh | bash",
  );
});

test("resume failure with resumeAttempted → resume_failed", () => {
  const err = normalizeClaudeStartError(
    new Error("No conversation found with session ID sess-123"),
    { resumeAttempted: true },
  );
  assert.ok(err instanceof AdapterError);
  assert.equal(err.code, "resume_failed");
});

test("other SDK errors are normalized via toAdapterError", () => {
  const err = normalizeClaudeStartError(
    new Error("ProcessTransport is not ready for writing"),
  );
  assert.ok(err instanceof AdapterError);
  assert.equal(err.code, "unknown");
  assert.equal(err.message, "ProcessTransport is not ready for writing");
});

test("already-normalized AdapterError passes through", () => {
  const original = new AdapterError("timeout", "probe timed out");
  assert.equal(normalizeClaudeStartError(original), original);
});
