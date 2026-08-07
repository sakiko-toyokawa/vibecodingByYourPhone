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
      id: "budget-hidden",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: "/tmp/target" },
      verification: { required: [] },
      persistence: { state_file: ".loop/STATE.md" },
      stop_rules: { max_turns: 3, max_time_minutes: 10, max_retries: 2 },
      ...overrides,
    },
  } as LoopCard;
}

test("max_turns < 1 throws ContractValidationError", () => {
  assert.throws(
    () =>
      buildBudgetLimits(
        makeCard({
          stop_rules: { max_turns: 0, max_time_minutes: 10, max_retries: 2 },
        }),
      ),
    (err: unknown) =>
      err instanceof ContractValidationError &&
      /max_turns must be >= 1/.test(err.message) &&
      /budget-hidden/.test(err.message),
  );
});

test("max_retries < 0 throws ContractValidationError", () => {
  assert.throws(
    () =>
      buildBudgetLimits(
        makeCard({
          stop_rules: { max_turns: 3, max_time_minutes: 10, max_retries: -1 },
        }),
      ),
    (err: unknown) =>
      err instanceof ContractValidationError &&
      /max_retries must be >= 0/.test(err.message),
  );
});

test("max_time_minutes <= 0 throws ContractValidationError", () => {
  assert.throws(
    () =>
      buildBudgetLimits(
        makeCard({
          stop_rules: { max_turns: 3, max_time_minutes: 0, max_retries: 2 },
        }),
      ),
    (err: unknown) =>
      err instanceof ContractValidationError &&
      /max_time_minutes must be > 0/.test(err.message),
  );
});

test("negative max_time_minutes also throws", () => {
  assert.throws(
    () =>
      buildBudgetLimits(
        makeCard({
          stop_rules: { max_turns: 3, max_time_minutes: -5, max_retries: 2 },
        }),
      ),
    (err: unknown) => err instanceof ContractValidationError,
  );
});

test("buildIntentContract propagates the validation error", () => {
  assert.throws(
    () =>
      buildIntentContract(
        makeCard({
          stop_rules: { max_turns: 0, max_time_minutes: 10, max_retries: 2 },
        }),
        { runId: "run-invalid", source: "manual" },
      ),
    (err: unknown) => err instanceof ContractValidationError,
  );
});

test("budget object does not include used_* counters", () => {
  const budget = buildBudgetLimits(makeCard());
  assert.equal((budget as Record<string, unknown>).used_tokens, undefined);
  assert.equal((budget as Record<string, unknown>).used_turns, undefined);
  assert.equal((budget as Record<string, unknown>).used_retries, undefined);
  assert.equal(
    (budget as Record<string, unknown>).used_time_minutes,
    undefined,
  );
});
