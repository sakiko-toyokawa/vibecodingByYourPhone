import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunLedgerEntry } from "@yep-anywhere/shared";
import type { RunLedgerStore } from "../state/run-ledger-store.js";
import { buildLedgerSummary } from "./ledger-summary.js";

test("ledger summary failure tags follow the terminal decision", async () => {
  const entry = {
    verification_refs: {
      judgment_report: "artifact://run-1/judgment-report.json",
    },
    artifact_refs: [],
  } as unknown as RunLedgerEntry;
  const store = {
    readArtifact: async () => null,
    readDecisionEntries: async () => [
      {
        decision: "retry",
        failure_tags: ["verification_error"],
      },
      {
        decision: "complete",
        failure_tags: [],
      },
    ],
  } as unknown as RunLedgerStore;

  const summary = await buildLedgerSummary(
    { runLedgerStore: store },
    "run-1",
    "loop-1",
    entry,
  );

  assert.equal(summary.judgment_summary, null);
  assert.deepEqual(summary.failure_tags, []);
});

test("ledger summary keeps failure tags from a failed terminal decision", async () => {
  const entry = {
    verification_refs: {
      judgment_report: "artifact://run-1/judgment-report.json",
    },
    artifact_refs: [],
  } as unknown as RunLedgerEntry;
  const store = {
    readArtifact: async () => null,
    readDecisionEntries: async () => [
      {
        decision: "retry",
        failure_tags: ["verification_error"],
      },
      {
        decision: "failed",
        failure_tags: ["verification_error"],
      },
    ],
  } as unknown as RunLedgerStore;

  const summary = await buildLedgerSummary(
    { runLedgerStore: store },
    "run-1",
    "loop-1",
    entry,
  );

  assert.deepEqual(summary.failure_tags, ["verification_error"]);
});
