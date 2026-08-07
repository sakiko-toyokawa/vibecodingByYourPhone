import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
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

test("status and history survive a store reload", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = new ProposalStore({ dataDir });
    await store.initialize();
    await store.create(makeProposal());
    await store.transitionStatus("prop_20260720_001", "shadow", {
      stage: "shadow",
    });

    const reopened = new ProposalStore({ dataDir });
    await reopened.initialize();
    assert.equal(reopened.get("prop_20260720_001")?.status, "shadow");
    assert.equal(reopened.getHistory("prop_20260720_001").length, 1);
    assert.equal(reopened.list("shadow").length, 1);
  });
});

test("create rejects non-draft starting status and unsafe ids", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = new ProposalStore({ dataDir });
    await store.initialize();

    await assert.rejects(
      store.create(makeProposal({ status: "shadow" })),
      (error: unknown) =>
        error instanceof ProposalStoreError &&
        error.code === "invalid_proposal",
    );
    await assert.rejects(
      store.create(makeProposal({ proposal_id: "../escape" })),
      (error: unknown) =>
        error instanceof ProposalStoreError &&
        error.code === "invalid_proposal",
    );
  });
});

test("corrupt proposal file is backed up and skipped during initialize", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = new ProposalStore({ dataDir });
    await store.initialize();
    await store.create(makeProposal());

    const filePath = join(
      dataDir,
      "loops",
      "learning",
      "proposals",
      "prop_20260720_001.json",
    );
    await writeFile(filePath, "{ not valid json !!!", "utf-8");

    const reopened = new ProposalStore({ dataDir });
    await reopened.initialize();
    assert.equal(reopened.get("prop_20260720_001"), undefined);
    assert.deepEqual(reopened.list(), []);

    const files = await readdir(
      join(dataDir, "loops", "learning", "proposals"),
    );
    assert.ok(
      files.some((f) => f.startsWith("prop_20260720_001.json.corrupt-")),
    );
  });
});

test("transition rejects unknown proposal with proposal_not_found", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = new ProposalStore({ dataDir });
    await store.initialize();
    assert.throws(
      () => store.getHistory("nope"),
      (error: unknown) =>
        error instanceof ProposalStoreError &&
        error.code === "proposal_not_found",
    );
    await assert.rejects(
      store.transitionStatus("nope", "shadow"),
      (error: unknown) =>
        error instanceof ProposalStoreError &&
        error.code === "proposal_not_found",
    );
  });
});
