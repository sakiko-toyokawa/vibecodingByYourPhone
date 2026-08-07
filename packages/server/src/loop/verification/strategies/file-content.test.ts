import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { IntentContract } from "@yep-anywhere/shared";
import { FileContentStrategy } from "./file-content.js";

function makeContract(): IntentContract {
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
    success_criteria: [],
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

function makeInput(
  workspacePath: string,
  artifacts: Record<string, string> = {},
  phase: "static" | "runtime" | "rule" | "structural" = "static",
) {
  return {
    contract: makeContract(),
    workspacePath,
    exitStatus: 0,
    artifacts,
    turn: 1,
    phase,
    writeEvidence: async () => "",
  };
}

test("FileContentStrategy: 优先读 workspace 文件 (P1)", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "verifier-test-"));
  try {
    await writeFile(
      join(workspacePath, "search-results.md"),
      "# Candidates\n\n- issue A\n",
    );
    const strategy = new FileContentStrategy([
      { file: "search-results.md", pattern: "issue A" },
    ]);
    const report = await strategy.verify(makeInput(workspacePath));
    assert.equal(report.status, "passed");
    assert.match(report.evidence_refs[0] ?? "", /^workspace:\/\//);
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("FileContentStrategy: workspace 缺文件时回落 artifacts", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "verifier-test-"));
  try {
    const strategy = new FileContentStrategy([
      { file: "report.md", pattern: "done" },
    ]);
    const report = await strategy.verify(
      makeInput(workspacePath, { "report.md": "all done" }),
    );
    assert.equal(report.status, "passed");
    assert.match(report.evidence_refs[0] ?? "", /^artifact:\/\//);
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("FileContentStrategy: 内容不匹配判 failed", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "verifier-test-"));
  try {
    await writeFile(join(workspacePath, "report.md"), "nothing here");
    const strategy = new FileContentStrategy([
      { file: "report.md", pattern: "done" },
    ]);
    const report = await strategy.verify(makeInput(workspacePath));
    assert.equal(report.status, "failed");
    assert.equal(report.recommendation, "retry");
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("FileContentStrategy: verifier_phase 跟随输入 phase (不再硬编码 static)", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "verifier-test-"));
  try {
    await writeFile(join(workspacePath, "report.md"), "done");
    const strategy = new FileContentStrategy([
      { file: "report.md", pattern: "done" },
    ]);
    const report = await strategy.verify(makeInput(workspacePath, {}, "rule"));
    assert.equal(report.verifier_phase, "rule");
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});
