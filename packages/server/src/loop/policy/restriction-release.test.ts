import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RESTRICTION_RELEASE_BEGIN,
  RESTRICTION_RELEASE_END,
  extractRestrictionRelease,
  isSameToolCall,
} from "./restriction-release.js";

test("extractRestrictionRelease parses a valid Bash release request", () => {
  const report = [
    "I could not run this command.",
    RESTRICTION_RELEASE_BEGIN,
    JSON.stringify({
      tool: "Bash",
      input: { command: "gh issue close 12 --repo owner/repo" },
      reason: "Issue confirmed fixed",
    }),
    RESTRICTION_RELEASE_END,
  ].join("\n");

  const release = extractRestrictionRelease(report);
  assert.deepEqual(release, {
    tool: "Bash",
    input: { command: "gh issue close 12 --repo owner/repo" },
    summary: "gh issue close 12 --repo owner/repo",
    reason: "Issue confirmed fixed",
  });
});

test("extractRestrictionRelease rejects invalid or missing payloads", () => {
  assert.equal(extractRestrictionRelease("no release block"), null);
  assert.equal(
    extractRestrictionRelease(
      `${RESTRICTION_RELEASE_BEGIN}\n{not json}\n${RESTRICTION_RELEASE_END}`,
    ),
    null,
  );
  assert.equal(
    extractRestrictionRelease(
      `${RESTRICTION_RELEASE_BEGIN}\n{"tool":"Bash"}\n${RESTRICTION_RELEASE_END}`,
    ),
    null,
  );
  assert.equal(
    extractRestrictionRelease(
      `${RESTRICTION_RELEASE_BEGIN}\n{"tool":"Bash","input":null}\n${RESTRICTION_RELEASE_END}`,
    ),
    null,
  );
});

test("isSameToolCall requires exact tool and input", () => {
  const approved = {
    tool: "Bash",
    input: { command: "gh issue close 12" },
  };
  assert.equal(
    isSameToolCall(approved, {
      tool: "Bash",
      input: { command: "gh issue close 12" },
    }),
    true,
  );
  assert.equal(
    isSameToolCall(approved, {
      tool: "Bash",
      input: { command: "gh issue close 13" },
    }),
    false,
  );
  assert.equal(
    isSameToolCall(approved, {
      tool: "Gh",
      input: { command: "gh issue close 12" },
    }),
    false,
  );
});
