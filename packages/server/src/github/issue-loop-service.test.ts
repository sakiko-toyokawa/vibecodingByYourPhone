import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import type { LoopCardStore, LoopRunService } from "../loop/index.js";
import type { GitHubClient, GitHubToolProvisioner } from "./index.js";
import { GitHubIssueLoopService } from "./issue-loop-service.js";

test("GitHubIssueLoopService creates an issue-specific loop and starts one run", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-gh-issue-loop-"));
  try {
    const createdCards: LoopCard[] = [];
    const service = new GitHubIssueLoopService({
      dataDir,
      toolProvisioner: {
        ensureGh: async () => ({
          installed: true,
          path: "E:/data/tools/gh/2.64.0/bin/gh.exe",
          version: "2.64.0",
        }),
      } as GitHubToolProvisioner,
      githubClient: {
        searchIssues: async () => [
          {
            repository: "owner/repo",
            number: 7,
            title: "Bug in agent runner",
            url: "https://github.com/owner/repo/issues/7",
            labels: ["bug"],
          },
        ],
        cloneAndCheckoutBranch: async () => undefined,
      } as unknown as GitHubClient,
      loopCardStore: {
        getLoop: () => undefined,
        createLoop: async (card: LoopCard) => {
          createdCards.push(card);
          return {
            id: card.loop.id,
            card,
            created_at: "2026-07-24T00:00:00.000Z",
            updated_at: "2026-07-24T00:00:00.000Z",
            archived: false,
          };
        },
      } as unknown as LoopCardStore,
      runService: {
        startRun: async (loopId: string) => ({
          run_id: "run-1",
          loop_id: loopId,
          state: "active",
          source: "manual",
          created_at: "2026-07-24T00:00:00.000Z",
        }),
      } as unknown as LoopRunService,
    });

    const result = await service.startFromQuery(
      "label:bug language:TypeScript",
    );

    assert.equal(result.issue.repository, "owner/repo");
    assert.equal(result.loopId, "github-owner-repo-issue-7");
    assert.equal(result.run.run_id, "run-1");
    assert.equal(createdCards[0]?.loop.workspace.strategy, "direct");
    assert.match(
      createdCards[0]?.loop.handoff?.task ?? "",
      /https:\/\/github\.com\/owner\/repo\/issues\/7/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("GitHubIssueLoopService fails cleanly when the query finds no issue", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-gh-issue-loop-"));
  try {
    const service = new GitHubIssueLoopService({
      dataDir,
      toolProvisioner: {
        ensureGh: async () => ({
          installed: true,
          path: "E:/data/tools/gh/2.64.0/bin/gh.exe",
          version: "2.64.0",
        }),
      } as GitHubToolProvisioner,
      githubClient: {
        searchIssues: async () => [],
      } as unknown as GitHubClient,
      loopCardStore: {} as LoopCardStore,
      runService: {} as LoopRunService,
    });

    await assert.rejects(
      () => service.startFromQuery("label:bug"),
      /No GitHub issues matched/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
