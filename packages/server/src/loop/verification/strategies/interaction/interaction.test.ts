import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { IntentContract } from "@yep-anywhere/shared";
import { InteractionAgentStrategy } from "./index.js";

function makeContract(criteria: string[] = []): IntentContract {
  return {
    intent_id: "intent-interaction",
    source: "ui",
    raw_goal: "verify the dashboard works",
    task_type: {
      primary: "maintenance",
      confidence: 1,
      requires_clarification: false,
    },
    outcome: "dashboard can be used",
    success_criteria: criteria,
    constraints: [],
    budget: {
      max_tokens: 0,
      max_time_minutes: 10,
      max_turns: 1,
      max_retries: 0,
    },
    security_level: "workspace_write",
  } as IntentContract;
}

async function withWorkspace(
  fn: (
    workspacePath: string,
    evidence: Record<string, string>,
  ) => Promise<void>,
) {
  const workspacePath = await mkdtemp(join(tmpdir(), "interaction-strategy-"));
  const evidence: Record<string, string> = {};
  try {
    await fn(workspacePath, evidence);
  } finally {
    await rm(workspacePath, { recursive: true, force: true, maxRetries: 5 });
  }
}

function makeInput(
  workspacePath: string,
  evidence: Record<string, string>,
): Parameters<InteractionAgentStrategy["verify"]>[0] {
  return {
    contract: makeContract(["dashboard title is visible"]),
    workspacePath,
    exitStatus: 0,
    artifacts: {},
    turn: 1,
    phase: "interaction",
    writeEvidence: async (name, content) => {
      evidence[name] = content;
      return `artifact://run-interaction/${name}`;
    },
  };
}

test("InteractionAgentStrategy: missing Playwright dependency is inconclusive and asks for human setup", async () => {
  await withWorkspace(async (workspacePath, evidence) => {
    const strategy = new InteractionAgentStrategy({
      checkDependencies: async () => ({
        status: "missing",
        message: "Playwright test dependency is not installed",
        installCommand: "pnpm add -D @playwright/test playwright",
      }),
    });

    const report = await strategy.verify(makeInput(workspacePath, evidence));

    assert.equal(report.status, "inconclusive");
    assert.equal(report.recommendation, "escalate");
    assert.equal(report.requires_human, true);
    assert.match(report.unresolved_risks[0] ?? "", /Playwright/);
    assert.match(evidence["interaction-deps.json"] ?? "", /missing/);
  });
});

test("InteractionAgentStrategy: invalid agent JSON is inconclusive", async () => {
  await withWorkspace(async (workspacePath) => {
    const strategy = new InteractionAgentStrategy({
      checkDependencies: async () => ({ status: "ready", message: "ready" }),
      generateScript: async () => "not json",
    });

    const report = await strategy.verify(makeInput(workspacePath, {}));

    assert.equal(report.status, "inconclusive");
    assert.equal(report.recommendation, "escalate");
    assert.match(report.unresolved_risks[0] ?? "", /無法解析/);
  });
});

test("InteractionAgentStrategy: script exit 0 passes", async () => {
  await withWorkspace(async (workspacePath, evidence) => {
    const strategy = new InteractionAgentStrategy({
      checkDependencies: async () => ({ status: "ready", message: "ready" }),
      generateScript: async () =>
        JSON.stringify({
          script: "console.log('interaction ok')",
          rationale: "checks the visible title",
          assumptions: [],
        }),
      executeScript: async () => ({
        kind: "exit",
        exitCode: 0,
        output: "interaction ok",
        durationMs: 12,
      }),
    });

    const report = await strategy.verify(makeInput(workspacePath, evidence));

    assert.equal(report.status, "passed");
    assert.equal(report.recommendation, "stop");
    assert.match(evidence["interaction-test.mjs"] ?? "", /interaction ok/);
    assert.match(evidence["interaction-output.log"] ?? "", /exit 0/);
  });
});

test("InteractionAgentStrategy: assertion failure retries", async () => {
  await withWorkspace(async (workspacePath) => {
    const strategy = new InteractionAgentStrategy({
      checkDependencies: async () => ({ status: "ready", message: "ready" }),
      generateScript: async () =>
        JSON.stringify({
          script: "throw new Error('missing title')",
          rationale: "checks the visible title",
          assumptions: [],
        }),
      executeScript: async () => ({
        kind: "exit",
        exitCode: 1,
        output: "Error: missing title",
        durationMs: 12,
      }),
    });

    const report = await strategy.verify(makeInput(workspacePath, {}));

    assert.equal(report.status, "failed");
    assert.equal(report.recommendation, "retry");
    assert.match(report.unresolved_risks[0] ?? "", /exited with code 1/);
  });
});
