import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MaintenanceTargetStore } from "../maintenance/index.js";
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
      last_processed: {
        comment_id: 12,
        issue_comment_id: 13,
        commit_sha: "sha1",
        ci_failure_sha: "sha1",
      },
      feedback_count: 1,
    });
    assert.ok(updated);
    assert.equal(updated?.state, "fixing");
    assert.equal(updated?.last_processed.comment_id, 12);
    assert.equal(updated?.last_processed.issue_comment_id, 13);
    assert.equal(updated?.last_processed.commit_sha, "sha1");
    assert.equal(updated?.last_processed.ci_failure_sha, "sha1");
    assert.equal(updated?.feedback_count, 1);
    assert.equal(updated?.subject.pr_number, 490);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RelationStore supports awaiting_review and pending_publish", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-relations-"));
  try {
    const store = new RelationStore({ dataDir });
    await store.initialize();
    const relation = {
      ...makeRelation(),
      state: "awaiting_review" as const,
      pending_publish: {
        repository: "open-multi-agent/open-multi-agent",
        branch: "fix/488-isolate-oma-model-in-runtime-tests",
        title: "Isolate ambient OMA_MODEL in runtime tests",
        body: "Prevents the ambient environment from breaking runtime tests.",
        cwd: "E:/data/github-workspaces/prompt-loops/github-agent-maintainer",
        run_id: "run-pending",
        created_at: new Date().toISOString(),
      },
    };
    await store.upsert(relation);
    const found = store.findById("rel-oma-488");
    assert.equal(found?.state, "awaiting_review");
    assert.equal(found?.pending_publish?.title, relation.pending_publish.title);

    const updated = await store.updateState("rel-oma-488", "awaiting_feedback");
    assert.equal(updated?.state, "awaiting_feedback");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RelationStore migrates legacy relations.json into maintenance targets", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-relations-"));
  try {
    const legacyDir = join(dataDir, "loops", "relations");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      join(legacyDir, "relations.json"),
      JSON.stringify({
        version: 1,
        relations: {
          "rel-oma-488": makeRelation(),
        },
      }),
    );
    const targetStore = new MaintenanceTargetStore({ dataDir });
    const store = new RelationStore({
      dataDir,
      maintenanceTargetStore: targetStore,
    });
    await targetStore.initialize();
    await store.initialize();

    assert.ok(store.findById("rel-oma-488"));
    const target = targetStore.findById("rel-oma-488");
    assert.equal(target?.target_type, "github_pr");
    assert.equal(
      target?.adapter_data?.repository,
      "open-multi-agent/open-multi-agent",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
