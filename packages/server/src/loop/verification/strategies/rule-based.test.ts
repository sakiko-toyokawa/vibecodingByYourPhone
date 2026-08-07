import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { IntentContract, VerificationRule } from "@yep-anywhere/shared";
import { RuleBasedStrategy } from "./rule-based.js";

function makeContract(targetFiles?: string[]): IntentContract {
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
    ...(targetFiles ? { target: { files: targetFiles } } : {}),
  } as IntentContract;
}

function makeInput(
  workspacePath: string,
  artifacts: Record<string, string> = {},
  targetFiles?: string[],
) {
  return {
    contract: makeContract(targetFiles),
    workspacePath,
    exitStatus: 0,
    artifacts,
    turn: 1,
    phase: "rule" as const,
    writeEvidence: async () => "",
  };
}

const NO_SECRETS_RULE: VerificationRule = {
  name: "no-hardcoded-secrets",
  pattern: "secret",
  severity: "error",
  message: "檢測到疑似硬編碼密鑰",
  suggestion: "改用環境變數",
  scope: "changed",
};

test("RuleBasedStrategy: 無任何規則時回 inconclusive + escalate", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "verifier-rule-"));
  try {
    const strategy = new RuleBasedStrategy([]);
    const report = await strategy.verify(makeInput(workspacePath));
    assert.equal(report.status, "inconclusive");
    assert.equal(report.recommendation, "escalate");
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("RuleBasedStrategy: scope=changed 從 diff.patch 取檔並命中 error 判 failed", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "verifier-rule-"));
  try {
    await mkdir(join(workspacePath, "src"), { recursive: true });
    await writeFile(
      join(workspacePath, "src", "config.ts"),
      'const a = 1;\nconst key = "secret-value";\n',
    );
    const diff = [
      "diff --git a/src/config.ts b/src/config.ts",
      "--- a/src/config.ts",
      "+++ b/src/config.ts",
      "@@ -1 +1,2 @@",
      '+const key = "secret-value";',
    ].join("\n");
    const strategy = new RuleBasedStrategy([NO_SECRETS_RULE]);
    const report = await strategy.verify(
      makeInput(workspacePath, { "diff.patch": diff }),
    );
    assert.equal(report.status, "failed");
    assert.equal(report.recommendation, "retry");
    assert.match(report.unresolved_risks[0] ?? "", /config\.ts:2/);
    assert.equal(report.issues?.[0]?.severity, "major");
    assert.equal(report.issues?.[0]?.location?.line, 2);
    assert.match(report.issues?.[0]?.suggestion ?? "", /環境變數/);
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("RuleBasedStrategy: warning 命中不阻塞, 只進 issues", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "verifier-rule-"));
  try {
    await writeFile(join(workspacePath, "src.ts"), "console.log(1);\n");
    const diff = "+++ b/src.ts\n";
    const strategy = new RuleBasedStrategy([
      {
        name: "no-console-log",
        pattern: "console\\.log",
        severity: "warning",
        message: "新增程式碼含 console.log",
        scope: "changed",
      },
    ]);
    const report = await strategy.verify(
      makeInput(workspacePath, { "diff.patch": diff }),
    );
    assert.equal(report.status, "passed");
    assert.equal(report.issues?.[0]?.severity, "minor");
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("RuleBasedStrategy: workspace .verifier/rules.json 被載入執行", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "verifier-rule-"));
  try {
    await mkdir(join(workspacePath, ".verifier"), { recursive: true });
    await writeFile(
      join(workspacePath, ".verifier", "rules.json"),
      JSON.stringify({
        version: 1,
        rules: [
          {
            name: "no-todo",
            pattern: "TODO",
            severity: "error",
            message: "殘留 TODO",
            scope: "changed",
          },
        ],
      }),
    );
    await writeFile(join(workspacePath, "a.ts"), "// TODO: fix\n");
    const strategy = new RuleBasedStrategy([]);
    const report = await strategy.verify(
      makeInput(workspacePath, { "diff.patch": "+++ b/a.ts\n" }),
    );
    assert.equal(report.status, "failed");
    assert.match(report.unresolved_risks[0] ?? "", /TODO/);
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("RuleBasedStrategy: .verifier/rules.json 非法時回 inconclusive", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "verifier-rule-"));
  try {
    await mkdir(join(workspacePath, ".verifier"), { recursive: true });
    await writeFile(
      join(workspacePath, ".verifier", "rules.json"),
      "{ not json",
    );
    const strategy = new RuleBasedStrategy([]);
    const report = await strategy.verify(makeInput(workspacePath));
    assert.equal(report.status, "inconclusive");
    assert.equal(report.recommendation, "escalate");
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("RuleBasedStrategy: scope=targets 只查合約 target.files", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "verifier-rule-"));
  try {
    await writeFile(join(workspacePath, "hit.ts"), "secret\n");
    await writeFile(join(workspacePath, "miss.ts"), "secret\n");
    const strategy = new RuleBasedStrategy([
      { ...NO_SECRETS_RULE, scope: "targets" },
    ]);
    const report = await strategy.verify(
      makeInput(workspacePath, {}, ["hit.ts"]),
    );
    assert.equal(report.status, "failed");
    assert.match(report.unresolved_risks[0] ?? "", /hit\.ts/);
    assert.ok(!report.unresolved_risks.some((r) => r.includes("miss.ts")));
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("RuleBasedStrategy: scope=workspace 掃全倉但排除 node_modules", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "verifier-rule-"));
  try {
    await writeFile(join(workspacePath, "src.ts"), "secret\n");
    await mkdir(join(workspacePath, "node_modules", "dep"), {
      recursive: true,
    });
    await writeFile(
      join(workspacePath, "node_modules", "dep", "x.ts"),
      "secret\n",
    );
    const strategy = new RuleBasedStrategy([
      { ...NO_SECRETS_RULE, scope: "workspace" },
    ]);
    const report = await strategy.verify(makeInput(workspacePath));
    assert.equal(report.status, "failed");
    assert.ok(report.unresolved_risks.some((r) => r.includes("src.ts")));
    assert.ok(!report.unresolved_risks.some((r) => r.includes("node_modules")));
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("RuleBasedStrategy: changed 無 diff 時回落 targets；皆無則記 info issue 不阻塞", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "verifier-rule-"));
  try {
    const strategy = new RuleBasedStrategy([NO_SECRETS_RULE]);
    const report = await strategy.verify(makeInput(workspacePath));
    assert.equal(report.status, "passed");
    assert.equal(report.issues?.[0]?.severity, "info");
    assert.match(report.issues?.[0]?.message ?? "", /無候選檔案/);
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});
