import assert from "node:assert/strict";
import { test } from "node:test";
import { hashLargeContent, redactForHumanReport } from "./redact.js";

test("absolute workspace path is replaced with {workspace}", () => {
  assert.equal(
    redactForHumanReport(
      "Run from C:\\Users\\alice\\repo and E:/projects/other",
      "C:\\Users\\alice\\repo",
    ),
    "Run from {workspace} and {abs-path}",
  );
});

test("secret-looking assignments and tokens are redacted", () => {
  const text = [
    "API_KEY=sk-abcdef1234567890abcdef",
    "GITHUB_TOKEN: ghp_123456789012345678901234",
    "password='hunter2'",
    "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const redacted = redactForHumanReport(text);
  assert.doesNotMatch(redacted, /sk-[A-Za-z0-9]/);
  assert.doesNotMatch(redacted, /ghp_/);
  assert.doesNotMatch(redacted, /hunter2/);
  assert.match(redacted, /\[REDACTED:private_key\]/);
  assert.match(redacted, /env:api_key/);
});

test("large content is replaced by a stable sha256 hash", () => {
  const large = "x".repeat(3000);
  const hashed = hashLargeContent(large, 100);
  assert.match(hashed, /^sha256:[a-f0-9]{64}$/);
  assert.equal(hashLargeContent(large, 100), hashLargeContent(large, 100));
});
