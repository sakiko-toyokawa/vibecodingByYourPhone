import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RelationStore } from "./relation-store.js";

function makeRelation() {
  return {
    relation_id: "rel-oma-488",
    loop_id: "github-agent-maintainer",
    subject: {
      type: "github_pr" as const,
      repository: "open-multi-agent/open-multi-agent",
      issue_number: 488,
      pr_number: 490,
      branch: "fix/488-isolate-oma-model-in-runtime-tests",
    },
    state: "awaiting_feedback" as const,
    last_processed: {},
    feedback_count: 0,
    repair_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

test("RelationStore persists relations and finds by GitHub PR", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-relations-"));
  try {
    const store = new RelationStore({ dataDir });
    await store.initialize();
    await store.upsert(makeRelation());

    const found = store.findByGitHubPr(
      "open-multi-agent/open-multi-agent",
      490,
    );
    assert.ok(found);
    assert.equal(found?.relation_id, "rel-oma-488");

    const reloaded = new RelationStore({ dataDir });
    await reloaded.initialize();
    assert.equal(
      reloaded.findById("rel-oma-488")?.subject.branch,
      "fix/488-isolate-oma-model-in-runtime-tests",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RelationStore updateState preserves subject and cursor fields", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-relations-"));
  try {
    const store = new RelationStore({ dataDir });
    await store.initialize();
    await store.upsert(makeRelation());
    const updated = await store.updateState("rel-oma-488", "fixing", {
      last_processed: { comment_id: 12 },
      feedback_count: 1,
    });
    assert.ok(updated);
    assert.equal(updated?.state, "fixing");
    assert.equal(updated?.last_processed.comment_id, 12);
    assert.equal(updated?.feedback_count, 1);
    assert.equal(updated?.subject.pr_number, 490);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
