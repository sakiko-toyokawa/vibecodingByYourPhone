import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIntentContract } from "../../../../packages/server/src/loop/contract/intent-contract.js";
import type { LoopCard } from "../../../../packages/shared/src/loop-schema/loop-card.js";

function makeCard(overrides: Partial<LoopCard["loop"]> = {}): LoopCard {
  return {
    loop: {
      id: "shape-hidden",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: "/tmp/target" },
      verification: { required: [] },
      persistence: { state_file: ".loop/STATE.md" },
      stop_rules: { max_turns: 3, max_time_minutes: 10, max_retries: 2 },
      ...overrides,
    },
  } as LoopCard;
}

test("read-only default task_type is read_only_report", () => {
  const contract = buildIntentContract(makeCard(), {
    runId: "run-type-ro",
    source: "manual",
  });
  assert.equal(contract.task_type.primary, "read_only_report");
  assert.equal(contract.task_type.confidence, 1);
  assert.equal(contract.task_type.requires_clarification, false);
});

test("write-capable default task_type is maintenance", () => {
  const contract = buildIntentContract(
    makeCard({ policy: { profile: "loop_bypass", approval_mode: "bypass" } }),
    { runId: "run-type-wc", source: "manual" },
  );
  assert.equal(contract.task_type.primary, "maintenance");
});

test("handoff.default_task_type overrides the primary task type", () => {
  const contract = buildIntentContract(
    makeCard({
      handoff: { default_task_type: "refactor" },
      policy: { profile: "loop_bypass", approval_mode: "bypass" },
    }),
    { runId: "run-type-override", source: "manual" },
  );
  assert.equal(contract.task_type.primary, "refactor");
});

test("read-only outcome and success_criteria forbid workspace modifications", () => {
  const contract = buildIntentContract(makeCard(), {
    runId: "run-outcome-ro",
    source: "manual",
  });
  assert.match(contract.outcome, /只读扫描报告/);
  assert.ok(contract.success_criteria.some((c) => /只读扫描完成/.test(c)));
  assert.ok(contract.success_criteria.some((c) => /未产生任何写改动/.test(c)));
});

test("write-capable outcome allows bounded workspace changes and forbids hard gates", () => {
  const contract = buildIntentContract(
    makeCard({ policy: { profile: "loop_bypass", approval_mode: "bypass" } }),
    { runId: "run-outcome-wc", source: "manual" },
  );
  assert.match(contract.outcome, /允许在工作区内/);
  assert.match(contract.outcome, /硬闸门动作禁止/);
  assert.ok(contract.success_criteria.some((c) => /任务目标完成/.test(c)));
  assert.ok(contract.success_criteria.some((c) => /未尝试硬闸门动作/.test(c)));
});

test("max_items_per_run is appended to constraints", () => {
  const contract = buildIntentContract(
    makeCard({ handoff: { max_items_per_run: 7 } }),
    { runId: "run-items", source: "manual" },
  );
  assert.ok(contract.constraints.includes("read_only"));
  assert.ok(contract.constraints.includes("max_items_per_run=7"));
});

test("stop_on_repeated_failure projects into stop_rules.repetition", () => {
  const contract = buildIntentContract(
    makeCard({
      stop_rules: {
        max_turns: 3,
        max_time_minutes: 10,
        max_retries: 2,
        stop_on_repeated_failure: 4,
      },
    }),
    { runId: "run-repeat", source: "manual" },
  );
  assert.deepEqual(contract.stop_rules, {
    repetition: { max_same_failure: 4 },
  });
});

test("stop_rules is absent when stop_on_repeated_failure is not declared", () => {
  const contract = buildIntentContract(makeCard(), {
    runId: "run-no-repeat",
    source: "manual",
  });
  assert.equal(contract.stop_rules, undefined);
});

test("cron source maps to cron, manual maps to ui", () => {
  const cronContract = buildIntentContract(
    makeCard({ trigger: { type: "schedule", cron: "0 0 * * *" } }),
    {
      runId: "run-cron",
      source: "cron",
    },
  );
  assert.equal(cronContract.source, "cron");

  const manualContract = buildIntentContract(makeCard(), {
    runId: "run-ui",
    source: "manual",
  });
  assert.equal(manualContract.source, "ui");
});

test("read-only raw_goal includes discovery source and query when task absent", () => {
  const contract = buildIntentContract(
    makeCard({
      discovery: { source: "github", query: "recent issues" },
    }),
    { runId: "run-discovery", source: "manual" },
  );
  assert.match(contract.raw_goal, /read-only scan/);
  assert.match(contract.raw_goal, /source=github/);
  assert.match(contract.raw_goal, /query=recent issues/);
});

test("write-capable raw_goal falls back to Loop task when handoff.task absent", () => {
  const contract = buildIntentContract(
    makeCard({ policy: { profile: "loop_bypass", approval_mode: "bypass" } }),
    { runId: "run-fallback", source: "manual" },
  );
  assert.equal(contract.raw_goal, "Loop 'shape-hidden' task");
});
