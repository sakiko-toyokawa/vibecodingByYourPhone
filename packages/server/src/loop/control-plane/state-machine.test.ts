import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunState } from "@yep-anywhere/shared";
import { RunStateSchema } from "@yep-anywhere/shared";
import {
  IllegalTransitionError,
  RUN_STATE_TRANSITIONS,
  assertLegalTransition,
  isLegalTransition,
} from "./state-machine.js";

const ALL_STATES = RunStateSchema.options;

// 权威迁移表（loop-engineering/control-plane/状态机.md / 02-schema契约.md §7）:
//   active → complete / retry / needs_human / paused / failed / budget_limited
//   retry → active
//   needs_human → active / failed / paused
//   paused → active
//   budget_limited → active
//   complete / failed → exit（无出边）
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

test("every legal transition of the authoritative table is accepted", () => {
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

test("every illegal transition is rejected (incl. terminal states and self-loops)", () => {
  let illegalCount = 0;
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      if (EXPECTED[from].includes(to)) {
        continue;
      }
      illegalCount += 1;
      assert.equal(
        isLegalTransition(from, to),
        false,
        `expected ${from} -> ${to} to be illegal`,
      );
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
  // 7×7 矩阵减去 12 条合法出边（active 6 + retry 1 + needs_human 3 +
  // paused 1 + budget_limited 1）。
  assert.equal(illegalCount, 49 - 12);
});

test("terminal states have no outgoing edges", () => {
  assert.deepEqual(RUN_STATE_TRANSITIONS.complete, []);
  assert.deepEqual(RUN_STATE_TRANSITIONS.failed, []);
});
