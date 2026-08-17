import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { RelationLifecycleService } from "./lifecycle-service.js";
import {
  ISSUE_PROPOSAL_BEGIN,
  ISSUE_PROPOSAL_END,
  PR_PUBLISH_BEGIN,
  PR_PUBLISH_END,
  extractPrPublishPayload,
  readGitIdentity,
} from "./pr-publish.js";
import { RelationStore } from "./relation-store.js";

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

test("registerGithubPrPublish rejects an already-open head PR", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "rtk-lc-dup-pr-"));
  try {
    const store = new RelationStore({ dataDir });
    await store.initialize();
    const lifecycle = new RelationLifecycleService({
      relationStore: store,
      githubClient: {
        findOpenPrByHead: async () => ({
          number: 12,
          title: "Fix bug",
          url: "https://github.com/owner/repo/pull/12",
        }),
      } as never,
    });

    const result = await lifecycle.registerGithubPrPublish(
      "loop-1",
      "run-1",
      [
        PR_PUBLISH_BEGIN,
        JSON.stringify({
          repository: "owner/repo",
          branch: "fix/12",
          title: "Fix bug",
          body: "Body",
          cwd: path.join(dataDir, "repo"),
        }),
        PR_PUBLISH_END,
      ].join("\n"),
    );

    assert.equal(result, null);
    assert.equal(store.list().length, 0);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("registerGithubPrPublish records unverified git identity", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "rtk-lc-id-"));
  const repoDir = await fs.mkdtemp(path.join(tmpdir(), "rtk-lc-id-repo-"));
  try {
    await execFileAsync("git", ["init", repoDir]);
    await execFileAsync("git", ["-C", repoDir, "config", "user.name", "wrong"]);
    await execFileAsync("git", [
      "-C",
      repoDir,
      "config",
      "user.email",
      "wrong@example.com",
    ]);
    const store = new RelationStore({ dataDir });
    await store.initialize();
    const lifecycle = new RelationLifecycleService({
      relationStore: store,
      githubClient: {
        getVerifiedIdentity: async () => ({
          login: "sakiko",
          email: "right@example.com",
          emails: ["right@example.com"],
        }),
      } as never,
    });

    const result = await lifecycle.registerGithubPrPublish(
      "loop-1",
      "run-1",
      [
        PR_PUBLISH_BEGIN,
        JSON.stringify({
          repository: "owner/repo",
          branch: "fix/12",
          title: "Fix bug",
          body: "Body",
          cwd: repoDir,
        }),
        PR_PUBLISH_END,
      ].join("\n"),
    );

    assert.equal(result?.pending_publish?.identity_verified, false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(repoDir, { recursive: true, force: true });
  }
});

test("registerGithubIssueProposal rejects an already-open issue title", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "rtk-lc-dup-issue-"));
  try {
    const store = new RelationStore({ dataDir });
    await store.initialize();
    const lifecycle = new RelationLifecycleService({
      relationStore: store,
      githubClient: {
        findOpenIssueByTitle: async () => ({
          number: 7,
          title: "Existing issue",
          url: "https://github.com/owner/repo/issues/7",
        }),
      } as never,
    });

    const result = await lifecycle.registerGithubIssueProposal(
      "loop-1",
      "run-1",
      [
        ISSUE_PROPOSAL_BEGIN,
        JSON.stringify({
          repository: "owner/repo",
          title: "Existing issue",
          body: "Body",
        }),
        ISSUE_PROPOSAL_END,
      ].join("\n"),
    );

    assert.equal(result, null);
    assert.equal(store.list().length, 0);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("extractIssueProposalPayload parses a valid proposal block", async () => {
  const {
    extractIssueProposalPayload,
    ISSUE_PROPOSAL_BEGIN,
    ISSUE_PROPOSAL_END,
  } = await import("./pr-publish.js");
  const text = `报告正文。\n${ISSUE_PROPOSAL_BEGIN}\n{ "repository": "openai/codex", "title": "TUI output truncated", "body": "## Repro\\nsteps" }\n${ISSUE_PROPOSAL_END}`;
  assert.deepEqual(extractIssueProposalPayload(text), {
    repository: "openai/codex",
    title: "TUI output truncated",
    body: "## Repro\nsteps",
  });
});

test("extractIssueProposalPayload rejects missing fields and absent blocks", async () => {
  const {
    extractIssueProposalPayload,
    ISSUE_PROPOSAL_BEGIN,
    ISSUE_PROPOSAL_END,
  } = await import("./pr-publish.js");
  assert.equal(extractIssueProposalPayload("no block here"), null);
  assert.equal(
    extractIssueProposalPayload(
      `${ISSUE_PROPOSAL_BEGIN}{ "repository": "o/r", "title": "" }${ISSUE_PROPOSAL_END}`,
    ),
    null,
  );
});

test("extractIssueProposalPayload keeps the comment-on-existing-issue action", async () => {
  const {
    extractIssueProposalPayload,
    ISSUE_PROPOSAL_BEGIN,
    ISSUE_PROPOSAL_END,
  } = await import("./pr-publish.js");
  const text = `${ISSUE_PROPOSAL_BEGIN}{ "repository": "openai/codex", "title": "t", "body": "b", "action": "comment_on_existing_issue", "target_issue": 36750 }${ISSUE_PROPOSAL_END}`;
  assert.deepEqual(extractIssueProposalPayload(text), {
    repository: "openai/codex",
    title: "t",
    body: "b",
    action: "comment_on_existing_issue",
    target_issue: 36750,
  });
  // comment 动作缺 target_issue → 整个块无效
  const invalid = `${ISSUE_PROPOSAL_BEGIN}{ "repository": "o/r", "title": "t", "body": "b", "action": "comment_on_existing_issue" }${ISSUE_PROPOSAL_END}`;
  assert.equal(extractIssueProposalPayload(invalid), null);
});
