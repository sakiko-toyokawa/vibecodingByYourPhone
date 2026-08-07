import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IllegalTransitionError,
  RUN_STATE_TRANSITIONS,
  assertLegalTransition,
  isLegalTransition,
} from "../../../../packages/server/src/loop/control-plane/state-machine.js";
import { RunStateSchema } from "../../../../packages/shared/src/loop-schema/run-ledger.js";
import type { RunState } from "../../../../packages/shared/src/loop-schema/run-ledger.js";

const ALL_STATES = RunStateSchema.options;

const EXPECTED: Record<RunState, RunState[]> = {
  active: [
    "complete",
    "retry",
    "needs_human",
    "paused",
    "failed",
    "budget_limited",
  ],
  retry: ["active"],
  needs_human: ["active", "failed", "paused"],
  paused: ["active"],
  budget_limited: ["active"],
  complete: [],
  failed: [],
};

test("transition table covers exactly the 7-state enum", () => {
  assert.deepEqual(
    Object.keys(RUN_STATE_TRANSITIONS).sort(),
    [...ALL_STATES].sort(),
  );
});

test("every legal transition is accepted", () => {
  for (const from of ALL_STATES) {
    for (const to of EXPECTED[from]) {
      assert.ok(
        isLegalTransition(from, to),
        `expected ${from} -> ${to} to be legal`,
      );
      assert.doesNotThrow(() =>
        assertLegalTransition(from, to, { runId: "run-1", turn: 1 }),
      );
    }
  }
});

test("every illegal transition is rejected", () => {
  let illegalCount = 0;
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      if (EXPECTED[from].includes(to)) {
        continue;
      }
      illegalCount += 1;
      assert.equal(isLegalTransition(from, to), false);
      assert.throws(
        () => assertLegalTransition(from, to, { runId: "run-1", turn: 2 }),
        (error: unknown) =>
          error instanceof IllegalTransitionError &&
          error.from === from &&
          error.to === to &&
          error.context.turn === 2,
      );
    }
  }
  // 7×7 matrix minus 12 legal outgoing edges.
  assert.equal(illegalCount, 49 - 12);
});

test("terminal states have no outgoing edges", () => {
  assert.deepEqual(RUN_STATE_TRANSITIONS.complete, []);
  assert.deepEqual(RUN_STATE_TRANSITIONS.failed, []);
});
