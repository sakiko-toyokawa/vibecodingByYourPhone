import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  ProposalStore,
  ProposalStoreError,
} from "../../../../packages/server/src/loop/state/proposal-store.js";
import type { ImprovementProposal } from "../../../../packages/shared/src/index.ts";
import { withTempDataDir } from "../../fixtures/temp-data-dir.js";

function makeProposal(
  overrides: Partial<ImprovementProposal> = {},
): ImprovementProposal {
  return {
    proposal_id: "prop_20260720_001",
    type: "memory_packet_template_proposal",
    source_patterns: ["fp_ci_retry_loop"],
    summary: "Inject workspace rules into CI fix memory packets",
    target: "loop_ci_fix.memory_packet_template",
    expected_effect: "Reduce context_error recurrence",
    risk: "medium",
    validation_plan: "Shadow + canary on golden tasks",
    status: "draft",
    created_by: "worker",
    created_at: "2026-07-20T11:00:00.000Z",
    ...overrides,
  };
}

test("create starts a proposal in draft and persists file + index", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = new ProposalStore({ dataDir });
    await store.initialize();
    await store.create(makeProposal());

    assert.equal(store.get("prop_20260720_001")?.status, "draft");
    const file = JSON.parse(
      await readFile(
        join(
          dataDir,
          "loops",
          "learning",
          "proposals",
          "prop_20260720_001.json",
        ),
        "utf-8",
      ),
    );
    assert.equal(file.proposal.proposal_id, "prop_20260720_001");
    assert.deepEqual(file.history, []);

    const index = JSON.parse(
      await readFile(
        join(dataDir, "loops", "learning", "proposals", "index.json"),
        "utf-8",
      ),
    );
    assert.equal(index.proposals.length, 1);
    assert.equal(index.proposals[0].status, "draft");
  });
});

test("pipeline advances draft → shadow → canary → approved → published", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = new ProposalStore({ dataDir });
    await store.initialize();
    await store.create(makeProposal());

    await store.transitionStatus("prop_20260720_001", "shadow", {
      stage: "shadow",
      reason: "enter shadow",
    });
    await store.transitionStatus("prop_20260720_001", "canary", {
      stage: "regression",
      reason: "eval passed",
    });
    await store.transitionStatus("prop_20260720_001", "approved", {
      stage: "canary",
      by: "human",
      reason: "canary ok",
    });
    const published = await store.transitionStatus(
      "prop_20260720_001",
      "published",
      { stage: "publish", by: "human" },
    );
    assert.equal(published.status, "published");

    const history = store.getHistory("prop_20260720_001");
    assert.equal(history.length, 4);
    assert.deepEqual(
      history.map((h) => `${h.from}->${h.to}`),
      [
        "draft->shadow",
        "shadow->canary",
        "canary->approved",
        "approved->published",
      ],
    );
    assert.equal(history[1]?.stage, "regression");
    assert.equal(history[2]?.by, "human");
  });
});

test("illegal transitions are rejected and do not mutate state", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = new ProposalStore({ dataDir });
    await store.initialize();
    await store.create(makeProposal());

    await assert.rejects(
      store.transitionStatus("prop_20260720_001", "published"),
      (error: unknown) =>
        error instanceof ProposalStoreError &&
        error.code === "invalid_transition",
    );

    await store.transitionStatus("prop_20260720_001", "shadow");
    await store.transitionStatus("prop_20260720_001", "canary");
    await store.transitionStatus("prop_20260720_001", "approved");
    await store.transitionStatus("prop_20260720_001", "published");

    await assert.rejects(
      store.transitionStatus("prop_20260720_001", "draft"),
      (error: unknown) =>
        error instanceof ProposalStoreError &&
        error.code === "invalid_transition",
    );
    assert.equal(store.get("prop_20260720_001")?.status, "published");
  });
});

test("rollback records reason and reaches terminal rolled_back", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = new ProposalStore({ dataDir });
    await store.initialize();
    await store.create(makeProposal());
    for (const to of ["shadow", "canary", "approved", "published"] as const) {
      await store.transitionStatus("prop_20260720_001", to);
    }

    const rolledBack = await store.rollback("prop_20260720_001", {
      by: "human",
      reason: "eval regression after publish",
    });
    assert.equal(rolledBack.status, "rolled_back");

    const history = store.getHistory("prop_20260720_001");
    const last = history[history.length - 1];
    assert.equal(last?.to, "rolled_back");
    assert.equal(last?.from, "published");
    assert.equal(last?.reason, "eval regression after publish");
    assert.equal(last?.by, "human");

    await assert.rejects(
      store.transitionStatus("prop_20260720_001", "shadow"),
      (error: unknown) =>
        error instanceof ProposalStoreError &&
        error.code === "invalid_transition",
    );
  });
});
