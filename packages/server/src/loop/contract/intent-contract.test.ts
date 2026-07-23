import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import { buildIntentContract } from "./intent-contract.js";

function makeCard(overrides: Partial<LoopCard["loop"]> = {}): LoopCard {
  return {
    loop: {
      id: "contract-test",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: "/tmp/target" },
      verification: { required: [] },
      persistence: { state_file: ".loop/STATE.md" },
      stop_rules: { max_turns: 3, max_time_minutes: 10, max_retries: 2 },
      ...overrides,
    },
  } as LoopCard;
}

test("no policy block keeps the legacy read-only contract", () => {
  const contract = buildIntentContract(makeCard(), {
    runId: "run-1",
    source: "manual",
  });
  assert.ok(contract.constraints.includes("read_only"));
  assert.match(contract.raw_goal, /read-only scan/);
});

test("bypass approval_mode produces a write-capable contract", () => {
  const contract = buildIntentContract(
    makeCard({ policy: { profile: "loop_bypass", approval_mode: "bypass" } }),
    { runId: "run-2", source: "manual" },
  );
  assert.ok(contract.constraints.includes("workspace_bounded"));
  assert.ok(!contract.constraints.includes("read_only"));
  assert.match(contract.outcome, /允许在工作区内/);
});

test("manual approval_mode degrades to read-only", () => {
  const contract = buildIntentContract(
    makeCard({ policy: { profile: "p", approval_mode: "manual" } }),
    { runId: "run-3", source: "manual" },
  );
  assert.ok(contract.constraints.includes("read_only"));
});

test("handoff.task overrides the generated raw_goal", () => {
  const contract = buildIntentContract(
    makeCard({
      handoff: { task: "Create or update REPORT.md with a workspace summary" },
      policy: { profile: "loop_bypass", approval_mode: "bypass" },
    }),
    { runId: "run-4", source: "manual" },
  );
  assert.equal(
    contract.raw_goal,
    "Create or update REPORT.md with a workspace summary",
  );
});
