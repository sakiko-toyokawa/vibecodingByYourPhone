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

// 权威迁移表 + run discard 扩展:
//   active → complete / retry / needs_human / paused / failed / budget_limited / discarded
//   retry → active / discarded
//   needs_human → active / failed / paused / discarded
//   paused → active / discarded
//   budget_limited → active / discarded
//   complete / failed → discarded
//   discarded → exit（无出边）
const EXPECTED: Record<RunState, RunState[]> = {
  active: [
    "complete",
    "retry",
    "needs_human",
    "paused",
    "failed",
    "budget_limited",
    "discarded",
  ],
  retry: ["active", "discarded"],
  needs_human: ["active", "failed", "paused", "discarded"],
  paused: ["active", "discarded"],
  budget_limited: ["active", "discarded"],
  complete: ["discarded"],
  failed: ["discarded"],
  discarded: [],
};

test("transition table covers exactly the run state enum", () => {
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
  // 8×8 矩阵减去 19 条合法出边（active 7 + retry 2 + needs_human 4 +
  // paused 2 + budget_limited 2 + complete 1 + failed 1）。
  assert.equal(illegalCount, 64 - 19);
});

test("discarded is the only exit-only terminal state", () => {
  assert.deepEqual(RUN_STATE_TRANSITIONS.complete, ["discarded"]);
  assert.deepEqual(RUN_STATE_TRANSITIONS.failed, ["discarded"]);
  assert.deepEqual(RUN_STATE_TRANSITIONS.discarded, []);
});
