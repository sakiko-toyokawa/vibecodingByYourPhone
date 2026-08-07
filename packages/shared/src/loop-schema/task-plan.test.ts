import assert from "node:assert/strict";
import test from "node:test";
import { SubTaskSchema, TaskPlanSchema } from "./task-plan.js";

test("SubTaskSchema accepts a valid subtask", () => {
  const subtask = SubTaskSchema.parse({
    id: "subtask-1",
    description: "Create plan.md",
    success_criteria: ["plan.md exists"],
    target_artifacts: ["plan.md"],
  });
  assert.equal(subtask.id, "subtask-1");
  assert.equal(subtask.description, "Create plan.md");
  assert.deepEqual(subtask.target_artifacts, ["plan.md"]);
});

test("SubTaskSchema defaults target_artifacts to empty array", () => {
  const subtask = SubTaskSchema.parse({
    id: "subtask-1",
    description: "Scan workspace",
    success_criteria: ["report written"],
  });
  assert.deepEqual(subtask.target_artifacts, []);
});

test("TaskPlanSchema accepts a valid plan", () => {
  const plan = TaskPlanSchema.parse({
    plan_id: "plan-1",
    created_at: "2026-07-28T00:00:00.000Z",
    subtasks: [
      {
        id: "subtask-1",
        description: "Plan",
        success_criteria: ["plan done"],
      },
      {
        id: "subtask-2",
        description: "Implement",
        success_criteria: ["code written"],
      },
    ],
  });
  assert.equal(plan.subtasks.length, 2);
});

test("TaskPlanSchema rejects empty subtasks", () => {
  assert.throws(() =>
    TaskPlanSchema.parse({
      plan_id: "plan-1",
      created_at: "2026-07-28T00:00:00.000Z",
      subtasks: [],
    }),
  );
});
