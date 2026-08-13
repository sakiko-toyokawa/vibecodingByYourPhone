import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunWorkingState } from "@yep-anywhere/shared";
import { validateRunWorkingState } from "./working-state-validation.js";

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
