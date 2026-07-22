import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_CAP_MS,
  retryBackoffMs,
} from "./retry-backoff.js";

// 退避：1min × 2^(n-1)，封顶 5min（retry-backoff.ts 头部注释）。

test("exponential backoff: 1min, 2min, 4min, then capped at 5min", () => {
  assert.equal(retryBackoffMs(1), 60_000);
  assert.equal(retryBackoffMs(2), 120_000);
  assert.equal(retryBackoffMs(3), 240_000);
  assert.equal(retryBackoffMs(4), 300_000); // 480_000 → 封顶
  assert.equal(retryBackoffMs(5), 300_000);
  assert.equal(retryBackoffMs(10), 300_000);
});

test("constants: base 1min, cap 5min", () => {
  assert.equal(RETRY_BACKOFF_BASE_MS, 60_000);
  assert.equal(RETRY_BACKOFF_CAP_MS, 300_000);
});

test("defensive: retryNumber < 1 falls back to the base backoff", () => {
  assert.equal(retryBackoffMs(0), RETRY_BACKOFF_BASE_MS);
});
