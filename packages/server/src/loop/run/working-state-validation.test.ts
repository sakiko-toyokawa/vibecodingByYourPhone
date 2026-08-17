import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunWorkingState, TaskPlan } from "@yep-anywhere/shared";
import {
  reconcileSubtaskStatusAgainstPlan,
  validateRunWorkingState,
} from "./working-state-validation.js";

function state(overrides: Partial<RunWorkingState> = {}): RunWorkingState {
  return {
    schema_version: 1,
    run_id: "run-1",
    updated_at: new Date().toISOString(),
    turn: 1,
    selected_subject: {
      repository: "owner/repo",
      clone_path: "C:/work/repo",
    },
    subtask_status: [],
    ...overrides,
  };
}

test("valid clone path and origin are accepted", async () => {
  const result = await validateRunWorkingState(state(), {
    pathExists: async () => true,
    gitRemote: async () => "https://github.com/owner/repo.git",
  });
  assert.equal(result.verified, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.failure_pattern, null);
});

test("missing clone path is rejected and becomes a failure pattern", async () => {
  const result = await validateRunWorkingState(state(), {
    pathExists: async () => false,
    gitRemote: async () => null,
  });
  assert.equal(result.verified, false);
  assert.match(result.issues[0] ?? "", /does not exist/);
  assert.equal(result.failure_pattern, "working_state_clone_path_mismatch");
});

test("origin mismatch is rejected", async () => {
  const result = await validateRunWorkingState(state(), {
    pathExists: async () => true,
    gitRemote: async () => "https://github.com/other/repo.git",
  });
  assert.equal(result.verified, false);
  assert.match(result.issues[0] ?? "", /does not match/);
});

test("reconcileSubtaskStatusAgainstPlan demotes later done subtasks", () => {
  const plan: TaskPlan = {
    plan_id: "plan-1",
    created_at: "2026-08-17T00:00:00.000Z",
    subtasks: Array.from({ length: 5 }, (_, index) => ({
      id: `subtask-${index + 1}`,
      description: `subtask ${index + 1}`,
      success_criteria: [`criterion ${index + 1}`],
      target_artifacts: [],
    })),
  };
  const reported = state({
    subtask_status: plan.subtasks.map((subtask) => ({
      id: subtask.id,
      status: "done" as const,
      outputs: "claimed done",
    })),
  });

  const reconciled = reconcileSubtaskStatusAgainstPlan(reported, plan, 2);

  assert.equal(reconciled.subtask_status.length, 5);
  assert.equal(reconciled.subtask_status[0]?.status, "done");
  assert.equal(reconciled.subtask_status[1]?.status, "done");
  assert.equal(reconciled.subtask_status[2]?.status, "done");
  assert.equal(reconciled.subtask_status[3]?.status, "pending");
  assert.equal(reconciled.subtask_status[4]?.status, "pending");
  assert.equal(reconciled.subtask_status[3]?.outputs, undefined);
});

test("reconcileSubtaskStatusAgainstPlan drops unknown subtask ids", () => {
  const plan: TaskPlan = {
    plan_id: "plan-2",
    created_at: "2026-08-17T00:00:00.000Z",
    subtasks: [
      {
        id: "subtask-1",
        description: "first",
        success_criteria: ["done"],
        target_artifacts: [],
      },
      {
        id: "subtask-2",
        description: "second",
        success_criteria: ["done"],
        target_artifacts: [],
      },
    ],
  };
  const reported = state({
    subtask_status: [
      { id: "ghost", status: "done" as const },
      { id: "subtask-1", status: "done" as const },
      { id: "subtask-2", status: "done" as const },
    ],
  });

  const reconciled = reconcileSubtaskStatusAgainstPlan(reported, plan, 0);

  assert.deepEqual(
    reconciled.subtask_status.map((entry) => entry.id),
    ["subtask-1", "subtask-2"],
  );
});
