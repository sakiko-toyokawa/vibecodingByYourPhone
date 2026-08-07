import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContractValidationError,
  buildBudgetLimits,
  buildIntentContract,
} from "../../../../packages/server/src/loop/contract/intent-contract.js";
import type { LoopCard } from "../../../../packages/shared/src/loop-schema/loop-card.js";

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

test("buildBudgetLimits projects stop_rules into budget with max_tokens=0", () => {
  const budget = buildBudgetLimits(makeCard());
  assert.equal(budget.max_tokens, 0);
  assert.equal(budget.max_turns, 3);
  assert.equal(budget.max_time_minutes, 10);
  assert.equal(budget.max_retries, 2);
});

test("max_retries >= max_turns is allowed (first-trigger-wins)", () => {
  const budget = buildBudgetLimits(
    makeCard({
      stop_rules: { max_turns: 2, max_time_minutes: 5, max_retries: 5 },
    }),
  );
  assert.equal(budget.max_turns, 2);
  assert.equal(budget.max_retries, 5);
});

test("minimal valid budget: max_turns=1, max_retries=0", () => {
  const budget = buildBudgetLimits(
    makeCard({
      stop_rules: { max_turns: 1, max_time_minutes: 1, max_retries: 0 },
    }),
  );
  assert.equal(budget.max_turns, 1);
  assert.equal(budget.max_retries, 0);
});

test("buildIntentContract includes the projected budget", () => {
  const contract = buildIntentContract(makeCard(), {
    runId: "run-budget",
    source: "manual",
  });
  assert.deepEqual(contract.budget, {
    max_tokens: 0,
    max_turns: 3,
    max_time_minutes: 10,
    max_retries: 2,
  });
});
