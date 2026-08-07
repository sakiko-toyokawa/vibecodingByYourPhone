import assert from "node:assert/strict";
import test from "node:test";
import { PlannerService } from "./planner.js";

function makeMockProvider(resultText: string) {
  return {
    name: "claude" as const,
    displayName: "Mock Claude",
    supportedPermissionModes: ["plan"] as const,
    supportsPermissionMode: true,
    supportsThinkingToggle: false,
    supportsSlashCommands: false,
    isInstalled: async () => true,
    isAuthenticated: async () => true,
    getAuthStatus: async () => ({
      installed: true,
      authenticated: true,
      enabled: true,
    }),
    getAvailableModels: async () => [],
    startSession: async () => ({
      iterator: (async function* () {
        yield {
          type: "result",
          result: resultText,
          is_error: false,
        };
      })(),
      queue: {} as never,
      abort: () => {},
    }),
  };
}

test("PlannerService decomposes a task into subtasks", async () => {
  const planner = new PlannerService({
    providerFactory: () =>
      makeMockProvider(
        JSON.stringify([
          {
            id: "subtask-1",
            description: "Create a plan document",
            success_criteria: ["plan.md exists"],
            target_artifacts: ["plan.md"],
          },
          {
            id: "subtask-2",
            description: "Implement the plan",
            success_criteria: ["src/main.js exists"],
            target_artifacts: ["src/main.js"],
          },
        ]),
      ),
  });
  const plan = await planner.planTask(
    "Research the workspace structure and create a detailed implementation plan, then implement the planned features and verify everything with tests",
  );
  assert.equal(plan.subtasks.length, 2);
  assert.equal(plan.subtasks[0]?.id, "subtask-1");
  assert.equal(plan.subtasks[1]?.id, "subtask-2");
});

test("PlannerService falls back to single subtask on invalid JSON", async () => {
  const planner = new PlannerService({
    providerFactory: () => makeMockProvider("not json"),
  });
  const plan = await planner.planTask("Create a plan and implement it");
  assert.equal(plan.subtasks.length, 1);
  assert.equal(plan.subtasks[0]?.description, "Create a plan and implement it");
});

test("PlannerService falls back to single subtask on provider failure", async () => {
  const planner = new PlannerService({
    providerFactory: () => null,
  });
  const plan = await planner.planTask("Create a plan and implement it");
  assert.equal(plan.subtasks.length, 1);
  assert.equal(plan.subtasks[0]?.description, "Create a plan and implement it");
});

test("PlannerService returns single subtask when agent judges task simple", async () => {
  const planner = new PlannerService({
    providerFactory: () =>
      makeMockProvider(
        JSON.stringify([
          {
            id: "subtask-1",
            description: "Fix the typo in README.md",
            success_criteria: ["typo fixed"],
            target_artifacts: [],
          },
        ]),
      ),
  });
  const plan = await planner.planTask("Fix a typo");
  assert.equal(plan.subtasks.length, 1);
  assert.equal(plan.subtasks[0]?.id, "subtask-1");
});
