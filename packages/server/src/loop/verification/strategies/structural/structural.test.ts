import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { IntentContract } from "@yep-anywhere/shared";
import { PythonChecker } from "./checkers/python.js";
import { RustChecker } from "./checkers/rust.js";
import { buildImportGraph, findCycles } from "./import-graph.js";
import { StructuralStrategy } from "./index.js";
import { SchemaChecker } from "./schema.js";
import { TypeScriptChecker } from "./typescript.js";

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

function makeInput(workspacePath: string) {
  const evidence: Record<string, string> = {};
  return {
    input: {
      contract: makeContract(),
      workspacePath,
      exitStatus: 0,
      artifacts: {} as Record<string, string>,
      turn: 1,
      phase: "structural" as const,
      writeEvidence: async (name: string, content: string) => {
        evidence[name] = content;
        return `artifact://run-1/${name}`;
      },
    },
    evidence,
  };
}

async function withWorkspace(
  files: Record<string, string>,
  fn: (workspacePath: string) => Promise<void>,
): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "verifier-structural-"));
  try {
    for (const [file, content] of Object.entries(files)) {
      const full = join(workspacePath, file);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, content);
    }
    await fn(workspacePath);
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
}

// --- import graph ---

test("import-graph: 偵測直接循環依賴", async () => {
  await withWorkspace(
    {
      "a.ts": 'import "./b";',
      "b.ts": 'import "./a";',
    },
    async (workspacePath) => {
      const graph = await buildImportGraph(workspacePath);
      const cycles = findCycles(graph);
      assert.equal(cycles.length, 1);
      assert.deepEqual(cycles[0], ["a.ts", "b.ts", "a.ts"]);
    },
  );
});

test("import-graph: 三節點循環 + 去重", async () => {
  await withWorkspace(
    {
      "a.ts": 'import "./b";',
      "b.ts": 'import "./c";',
      "c.ts": 'import "./a";',
    },
    async (workspacePath) => {
      const cycles = findCycles(await buildImportGraph(workspacePath));
      assert.equal(cycles.length, 1);
      assert.equal(cycles[0]?.length, 4);
    },
  );
});

test("import-graph: package import 與無環圖不誤報", async () => {
  await withWorkspace(
    {
      "a.ts": 'import path from "node:path";\nimport "./b";',
      "b.ts": "export const x = 1;",
    },
    async (workspacePath) => {
      const cycles = findCycles(await buildImportGraph(workspacePath));
      assert.equal(cycles.length, 0);
    },
  );
});

// --- TypeScript checker ---

test("TypeScriptChecker: 解析 tsc diagnostics 為帶位置的 issues", async () => {
  await withWorkspace(
    { "tsconfig.json": "{}", "a.ts": "const x: number = 's';" },
    async (workspacePath) => {
      const node = `"${process.execPath}"`;
      const fakeTsc = `${node} -e "console.log('src/a.ts(3,7): error TS2322: Type string is not assignable to type number.'); process.exit(2)"`;
      const checker = new TypeScriptChecker(fakeTsc);
      const outcome = await checker.run({
        workspacePath,
        phase: "structural",
      });
      assert.equal(outcome.applicable, true);
      assert.equal(outcome.inconclusive, false);
      assert.equal(outcome.issues.length, 1);
      assert.equal(outcome.issues[0]?.location?.file, "src/a.ts");
      assert.equal(outcome.issues[0]?.location?.line, 3);
      assert.match(outcome.issues[0]?.message ?? "", /TS2322/);
    },
  );
});

test("TypeScriptChecker: tsc 不存在時 inconclusive 而非假裝通過", async () => {
  await withWorkspace(
    { "tsconfig.json": "{}", "a.ts": "export const x = 1;" },
    async (workspacePath) => {
      const checker = new TypeScriptChecker("definitely-not-a-real-tsc-bin");
      const outcome = await checker.run({
        workspacePath,
        phase: "structural",
      });
      assert.equal(outcome.inconclusive, true);
      assert.match(outcome.risks[0] ?? "", /不可執行|無法取得/);
    },
  );
});

test("TypeScriptChecker: tsc 非零退出且無可解析 diagnostics 時 inconclusive", async () => {
  await withWorkspace(
    { "tsconfig.json": "{}", "a.ts": "export const x = 1;" },
    async (workspacePath) => {
      const node = `"${process.execPath}"`;
      const fakeTsc = `${node} -e "console.log('npm error npx canceled'); process.exit(1)"`;
      const outcome = await new TypeScriptChecker(fakeTsc).run({
        workspacePath,
        phase: "structural",
      });
      assert.equal(outcome.inconclusive, true);
      assert.match(outcome.risks[0] ?? "", /退出碼 1/);
    },
  );
});

test("TypeScriptChecker: 無 TS 痕跡時不適用", async () => {
  await withWorkspace({ "readme.md": "hi" }, async (workspacePath) => {
    const outcome = await new TypeScriptChecker().run({
      workspacePath,
      phase: "structural",
    });
    assert.equal(outcome.applicable, false);
  });
});

// --- Python checker ---

test("PythonChecker: 解析 pyright diagnostics 為帶位置的 issues", async () => {
  await withWorkspace(
    {
      "pyproject.toml": "",
      "src/a.py": "x: int = 's'",
    },
    async (workspacePath) => {
      const node = `"${process.execPath}"`;
      const fakePyright = `${node} -e "console.log('src/a.py:3:7 - error: \\"int\\" is not assignable to \\"str\\"'); process.exit(2)"`;
      const outcome = await new PythonChecker(fakePyright).run({
        workspacePath,
        phase: "structural",
      });
      assert.equal(outcome.applicable, true);
      assert.equal(outcome.inconclusive, false);
      assert.equal(outcome.issues.length, 1);
      assert.equal(outcome.issues[0]?.location?.file, "src/a.py");
      assert.equal(outcome.issues[0]?.location?.line, 3);
      assert.match(outcome.issues[0]?.message ?? "", /not assignable/);
    },
  );
});

test("PythonChecker: pyright 不存在時 inconclusive 而非假裝通過", async () => {
  await withWorkspace({ "src/a.py": "x = 1" }, async (workspacePath) => {
    const outcome = await new PythonChecker(
      "definitely-not-a-real-pyright",
    ).run({
      workspacePath,
      phase: "structural",
    });
    assert.equal(outcome.inconclusive, true);
    assert.match(outcome.risks[0] ?? "", /不可執行|無法取得/);
  });
});

// --- Rust checker ---

test("RustChecker: 解析 cargo check diagnostics 為帶位置的 issues", async () => {
  await withWorkspace(
    {
      "Cargo.toml": '[package]\nname = "demo"',
      "src/main.rs": 'fn main() { let x: i32 = "s"; }',
    },
    async (workspacePath) => {
      const node = `"${process.execPath}"`;
      const fakeCargo = `${node} -e "console.log('src/main.rs:5:9: error[E0308]: mismatched types'); process.exit(101)"`;
      const outcome = await new RustChecker(fakeCargo).run({
        workspacePath,
        phase: "structural",
      });
      assert.equal(outcome.applicable, true);
      assert.equal(outcome.issues.length, 1);
      assert.equal(outcome.issues[0]?.location?.file, "src/main.rs");
      assert.match(outcome.issues[0]?.message ?? "", /E0308/);
    },
  );
});

test("RustChecker: cargo 不存在時 inconclusive", async () => {
  await withWorkspace({ "Cargo.toml": "" }, async (workspacePath) => {
    const outcome = await new RustChecker("definitely-not-a-real-cargo").run({
      workspacePath,
      phase: "structural",
    });
    assert.equal(outcome.inconclusive, true);
    assert.match(outcome.risks[0] ?? "", /不可執行|無法取得/);
  });
});

// --- Schema checker ---

test("SchemaChecker: 配對資料違反 required 判 error issue", async () => {
  await withWorkspace(
    {
      "app.schema.json": JSON.stringify({
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      }),
      "app.json": JSON.stringify({ version: 1 }),
    },
    async (workspacePath) => {
      const outcome = await new SchemaChecker().run({
        workspacePath,
        phase: "structural",
      });
      assert.equal(outcome.applicable, true);
      assert.equal(outcome.issues.length, 1);
      assert.match(outcome.issues[0]?.message ?? "", /缺少必填欄位 'name'/);
    },
  );
});

test("SchemaChecker: 合法配對通過；無 schema 檔不適用", async () => {
  await withWorkspace(
    {
      "app.schema.json": JSON.stringify({
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      }),
      "app.json": JSON.stringify({ name: "ok" }),
    },
    async (workspacePath) => {
      const outcome = await new SchemaChecker().run({
        workspacePath,
        phase: "structural",
      });
      assert.equal(outcome.issues.length, 0);
    },
  );
  await withWorkspace({ "a.json": "{}" }, async (workspacePath) => {
    const outcome = await new SchemaChecker().run({
      workspacePath,
      phase: "structural",
    });
    assert.equal(outcome.applicable, false);
  });
});

// --- StructuralStrategy 聚合 ---

test("StructuralStrategy: 循環依賴判 failed + retry, issues 落進 report", async () => {
  await withWorkspace(
    {
      "a.ts": 'import "./b";',
      "b.ts": 'import "./a";',
    },
    async (workspacePath) => {
      const { input } = makeInput(workspacePath);
      const report = await new StructuralStrategy({
        typescript: new TypeScriptChecker(
          `"${process.execPath}" -e "process.exit(0)"`,
        ),
      }).verify(input);
      assert.equal(report.status, "failed");
      assert.equal(report.recommendation, "retry");
      assert.ok(
        report.issues?.some((issue) =>
          issue.id.startsWith("circular-dependency@"),
        ),
      );
    },
  );
});

test("StructuralStrategy: 乾淨 TS 專案判 passed, tsc log 落 evidence", async () => {
  await withWorkspace(
    { "tsconfig.json": "{}", "a.ts": "export const x = 1;" },
    async (workspacePath) => {
      const { input, evidence } = makeInput(workspacePath);
      const report = await new StructuralStrategy({
        typescript: new TypeScriptChecker(
          `"${process.execPath}" -e "process.exit(0)"`,
        ),
      }).verify(input);
      assert.equal(report.status, "passed");
      assert.equal(report.evidence_refs.length, 1);
      assert.match(evidence["structural-tsc-turn1.log"] ?? "", /exit 0/);
    },
  );
});

test("StructuralStrategy: 無適用 checker 時 unverified + escalate", async () => {
  await withWorkspace({ "readme.md": "hi" }, async (workspacePath) => {
    const { input } = makeInput(workspacePath);
    const report = await new StructuralStrategy().verify(input);
    assert.equal(report.status, "unverified");
    assert.equal(report.recommendation, "escalate");
    assert.match(report.unresolved_risks[0] ?? "", /無適用 checker/);
  });
});
