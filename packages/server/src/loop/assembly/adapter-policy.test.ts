import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAdapterPolicy } from "./adapter-policy.js";

test("resolveAdapterPolicy parses verifier-specific keys", () => {
  const resolved = resolveAdapterPolicy({
    model: "maker-model",
    verifier_model: "kimi-k3-256k",
    verifier_provider: "codex",
    timeout_seconds: 90,
  });

  assert.deepEqual(resolved, {
    model: "maker-model",
    verifier_model: "kimi-k3-256k",
    verifier_provider: "codex",
    timeoutMs: 90_000,
    ignoredKeys: [],
  });
});

test("resolveAdapterPolicy rejects invalid verifier values", () => {
  const resolved = resolveAdapterPolicy({
    verifier_model: "",
    verifier_provider: "not-a-provider",
  });

  assert.deepEqual(resolved, {
    ignoredKeys: ["verifier_model", "verifier_provider"],
  });
});

test("resolveAdapterPolicy keeps legacy payload behavior unchanged", () => {
  const resolved = resolveAdapterPolicy({
    model: "legacy-model",
    timeout_seconds: 30,
    unknown_key: "ignored",
  });

  assert.deepEqual(resolved, {
    model: "legacy-model",
    timeoutMs: 30_000,
    ignoredKeys: ["unknown_key"],
  });
});
