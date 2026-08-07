import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { IntentContract } from "@yep-anywhere/shared";
import { ContractCriteriaStrategy } from "./contract-criteria.js";

function makeContract(criteria: string[]): IntentContract {
  return {
    intent_id: "intent-test",
    source: "ui",
    raw_goal: "test task",
    task_type: {
      primary: "maintenance",
      confidence: 1,
      requires_clarification: false,
    },
    outcome: "test outcome",
    success_criteria: criteria,
    constraints: [],
    budget: {
      max_tokens: 0,
      max_time_minutes: 10,
      max_turns: 3,
      max_retries: 2,
    },
    security_level: "workspace_write",
  } as IntentContract;
}

test("ContractCriteriaStrategy: passes when all criteria are met", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "verifier-test-"));
  try {
    await writeFile(
      join(workspacePath, "search-results.md"),
      "# Candidate Issues\n\n1. Issue 1\n2. Issue 2\n3. Issue 3\n",
    );

    const strategy = new ContractCriteriaStrategy([
      "search-results.md exists",
      "search-results.md contains candidate issues",
    ]);

    const report = await strategy.verify({
      contract: makeContract(["search-results.md exists"]),
      workspacePath,
      exitStatus: 0,
      artifacts: {
        "search-results.md":
          "# Candidate Issues\n\n1. Issue 1\n2. Issue 2\n3. Issue 3\n",
      },
      turn: 1,
      phase: "static",
      writeEvidence: async () => "",
    });

    assert.equal(report.status, "passed");
    assert.equal(report.recommendation, "stop");
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("ContractCriteriaStrategy: fails when required file is missing", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "verifier-test-"));
  try {
    const strategy = new ContractCriteriaStrategy(["search-results.md exists"]);

    const report = await strategy.verify({
      contract: makeContract(["search-results.md exists"]),
      workspacePath,
      exitStatus: 0,
      artifacts: {},
      turn: 1,
      phase: "static",
      writeEvidence: async () => "",
    });

    assert.equal(report.status, "failed");
    assert.equal(report.recommendation, "retry");
    assert.match(report.unresolved_risks[0] ?? "", /search-results\.md/);
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("ContractCriteriaStrategy: fails when file does not contain expected content", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "verifier-test-"));
  try {
    await writeFile(
      join(workspacePath, "search-results.md"),
      "# No issues found\n",
    );

    const strategy = new ContractCriteriaStrategy([
      "search-results.md contains candidate issues",
    ]);

    const report = await strategy.verify({
      contract: makeContract(["search-results.md contains candidate issues"]),
      workspacePath,
      exitStatus: 0,
      artifacts: {
        "search-results.md": "# No issues found\n",
      },
      turn: 1,
      phase: "static",
      writeEvidence: async () => "",
    });

    assert.equal(report.status, "failed");
    assert.equal(report.recommendation, "retry");
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("ContractCriteriaStrategy: 引号内期望内容做精确子串比对 (P1)", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "verifier-test-"));
  try {
    await writeFile(
      join(workspacePath, "report.md"),
      "summary: found 3 candidate issues\n",
    );
    const strategy = new ContractCriteriaStrategy([
      'report.md contains "3 candidate issues"',
    ]);
    const report = await strategy.verify({
      contract: makeContract([]),
      workspacePath,
      exitStatus: 0,
      artifacts: {},
      turn: 1,
      phase: "static",
      writeEvidence: async () => "",
    });
    assert.equal(report.status, "passed");
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("ContractCriteriaStrategy: 引号内容缺失判 failed (P1)", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "verifier-test-"));
  try {
    await writeFile(join(workspacePath, "report.md"), "summary: nothing\n");
    const strategy = new ContractCriteriaStrategy([
      'report.md contains "3 candidate issues"',
    ]);
    const report = await strategy.verify({
      contract: makeContract([]),
      workspacePath,
      exitStatus: 0,
      artifacts: {},
      turn: 1,
      phase: "static",
      writeEvidence: async () => "",
    });
    assert.equal(report.status, "failed");
    assert.match(report.unresolved_risks[0] ?? "", /3 candidate issues/);
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("ContractCriteriaStrategy: 否定诉求 — 不得包含的内容出现时判 failed (P1)", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "verifier-test-"));
  try {
    await writeFile(
      join(workspacePath, "config.ts"),
      'const KEY = "sk-secret";',
    );
    const strategy = new ContractCriteriaStrategy([
      'config.ts must not contain "sk-secret"',
    ]);
    const report = await strategy.verify({
      contract: makeContract([]),
      workspacePath,
      exitStatus: 0,
      artifacts: {},
      turn: 1,
      phase: "static",
      writeEvidence: async () => "",
    });
    assert.equal(report.status, "failed");
    assert.match(report.unresolved_risks[0] ?? "", /must not contain/);
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("ContractCriteriaStrategy: 至少 N 次数量诉求 (P1)", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "verifier-test-"));
  try {
    await writeFile(
      join(workspacePath, "report.md"),
      "- issue one\n- issue two\n",
    );
    const strategy = new ContractCriteriaStrategy([
      'report.md contains at least 3 "issue"',
    ]);
    const report = await strategy.verify({
      contract: makeContract([]),
      workspacePath,
      exitStatus: 0,
      artifacts: {},
      turn: 1,
      phase: "static",
      writeEvidence: async () => "",
    });
    assert.equal(report.status, "failed");
    assert.match(report.unresolved_risks[0] ?? "", /2 occurrence/);
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});
