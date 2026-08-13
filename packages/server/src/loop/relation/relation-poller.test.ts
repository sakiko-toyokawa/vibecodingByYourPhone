import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RelationPoller } from "./relation-poller.js";
import { RelationStore } from "./relation-store.js";

function makeRelation(
  state:
    | "awaiting_feedback"
    | "fixing"
    | "awaiting_review" = "awaiting_feedback",
) {
  return {
    relation_id: "rel-1",
    loop_id: "loop-maintainer",
    subject: {
      type: "github_pr" as const,
      repository: "owner/repo",
      pr_number: 12,
      branch: "fix/12",
    },
    state,
    last_processed: {},
    feedback_count: 0,
    repair_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

test("RelationPoller enqueues new comments and reviews", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-rel-poll-"));
  try {
    const relationStore = new RelationStore({ dataDir });
    await relationStore.initialize();
    await relationStore.upsert(makeRelation());
    const enqueued: Array<{ event_id: string; payload: object }> = [];
    const poller = new RelationPoller({
      relationStore,
      githubClient: {
        getPullRequest: async () => ({
          state: "open",
          merged: false,
          head_sha: "sha",
        }),
        listPullRequestComments: async () => [
          { id: 3, body: "please fix", user: "reviewer", created_at: "now" },
        ],
        listPullRequestReviews: async () => [],
      } as never,
      triggerQueueStore: {
        enqueue: async (input: { event_id: string; payload: object }) => {
          enqueued.push(input);
          return { ...input, state: "pending" };
        },
      } as never,
    });
    const events = await poller.pollOnce();
    assert.equal(events, 1);
    assert.equal(enqueued.length, 1);
    assert.match(enqueued[0]?.event_id ?? "", /^github-poll-rel-1-3$/);
    assert.equal(
      (enqueued[0]?.payload as { relation_id: string }).relation_id,
      "rel-1",
    );
    assert.equal(
      (enqueued[0]?.payload as { maintenance_id: string }).maintenance_id,
      "rel-1",
    );
    const updated = relationStore.findById("rel-1");
    assert.equal(updated?.state, "fixing");
    assert.equal(updated?.last_processed.comment_id, 3);
    assert.equal(updated?.repair_count, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RelationPoller escalates repeated feedback to needs_human", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-rel-poll-"));
  try {
    const relationStore = new RelationStore({ dataDir });
    await relationStore.initialize();
    await relationStore.upsert({
      ...makeRelation(),
      repair_count: 3,
      last_processed: { comment_id: 2 },
    });
    let enqueued = 0;
    const poller = new RelationPoller({
      relationStore,
      githubClient: {
        getPullRequest: async () => ({
          state: "open",
          merged: false,
          head_sha: "sha",
        }),
        listPullRequestComments: async () => [
          {
            id: 5,
            body: "please fix again",
            user: "reviewer",
            created_at: "now",
          },
        ],
        listPullRequestReviews: async () => [],
      } as never,
      triggerQueueStore: {
        enqueue: async () => {
          enqueued += 1;
          return { event_id: "x", state: "pending" };
        },
      } as never,
    });
    await poller.pollOnce();
    assert.equal(enqueued, 0);
    assert.equal(relationStore.findById("rel-1")?.state, "needs_human");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RelationPoller marks merged relations terminal", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-rel-poll-"));
  try {
    const relationStore = new RelationStore({ dataDir });
    await relationStore.initialize();
    await relationStore.upsert(makeRelation());
    const poller = new RelationPoller({
      relationStore,
      githubClient: {
        getPullRequest: async () => ({
          state: "closed",
          merged: true,
          head_sha: "sha",
        }),
      } as never,
      triggerQueueStore: {
        enqueue: async () => {
          throw new Error("should not enqueue terminal relation");
        },
      } as never,
    });
    await poller.pollOnce();
    assert.equal(relationStore.findById("rel-1")?.state, "merged");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RelationPoller skips awaiting_review until the PR is marked ready", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-rel-poll-"));
  try {
    const relationStore = new RelationStore({ dataDir });
    await relationStore.initialize();
    await relationStore.upsert(makeRelation("awaiting_review"));
    let enqueued = 0;
    const poller = new RelationPoller({
      relationStore,
      githubClient: {
        getPullRequest: async () => {
          throw new Error("should not query PR before ready");
        },
      } as never,
      triggerQueueStore: {
        enqueue: async () => {
          enqueued += 1;
          return { event_id: "x", state: "pending" };
        },
      } as never,
    });
    const events = await poller.pollOnce();
    assert.equal(events, 0);
    assert.equal(enqueued, 0);
    assert.equal(relationStore.findById("rel-1")?.state, "awaiting_review");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
