import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  PR_PUBLISH_BEGIN,
  PR_PUBLISH_END,
  extractPrPublishPayload,
  readGitIdentity,
} from "./pr-publish.js";

const execFileAsync = promisify(execFile);

test("readGitIdentity reads the configured commit identity", async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "rtk-identity-"));
  try {
    await execFileAsync("git", ["init", dir]);
    await execFileAsync("git", ["-C", dir, "config", "user.name", "sakiko"]);
    await execFileAsync("git", [
      "-C",
      dir,
      "config",
      "user.email",
      "zhaodanshushu@outlook.com",
    ]);

    assert.deepEqual(await readGitIdentity(dir), {
      name: "sakiko",
      email: "zhaodanshushu@outlook.com",
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("extractPrPublishPayload extracts a marked JSON block", () => {
  const cwd = path.join(tmpdir(), "repo");
  const report = [
    "Fixed the issue locally.",
    PR_PUBLISH_BEGIN,
    JSON.stringify({
      repository: "owner/repo",
      branch: "fix/12",
      title: "Fix bug 12",
      body: "Closes #12",
      cwd,
    }),
    PR_PUBLISH_END,
    "trailing text",
  ].join("\n");

  assert.deepEqual(extractPrPublishPayload(report), {
    repository: "owner/repo",
    branch: "fix/12",
    title: "Fix bug 12",
    body: "Closes #12",
    cwd,
  });
});

test("extractPrPublishPayload handles a fenced JSON block", () => {
  const cwd = path.join(tmpdir(), "repo");
  const report = [
    PR_PUBLISH_BEGIN,
    "```json",
    `{"repository":"owner/repo","branch":"fix/12","title":"Fix","body":"Body","cwd":"${cwd.replace(/\\/g, "\\\\")}"}`,
    "```",
    PR_PUBLISH_END,
  ].join("\n");

  assert.deepEqual(extractPrPublishPayload(report), {
    repository: "owner/repo",
    branch: "fix/12",
    title: "Fix",
    body: "Body",
    cwd,
  });
});

test("extractPrPublishPayload returns null for missing or invalid blocks", () => {
  assert.equal(extractPrPublishPayload("no markers"), null);
  assert.equal(
    extractPrPublishPayload(
      `${PR_PUBLISH_BEGIN}\n{not json}\n${PR_PUBLISH_END}`,
    ),
    null,
  );
  assert.equal(
    extractPrPublishPayload(
      `${PR_PUBLISH_BEGIN}\n{"repository":"owner/repo","cwd":"/tmp/repo"}\n${PR_PUBLISH_END}`,
    ),
    null,
  );
  assert.equal(
    extractPrPublishPayload(
      `${PR_PUBLISH_BEGIN}\n{"repository":"owner/repo","branch":"fix/12","title":"Fix","body":"Body","cwd":"relative/repo"}\n${PR_PUBLISH_END}`,
    ),
    null,
  );
});
