import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildIntentContract,
  extractTargetFiles,
} from "../../../../packages/server/src/loop/contract/intent-contract.js";
import type { LoopCard } from "../../../../packages/shared/src/loop-schema/loop-card.js";

function makeCard(overrides: Partial<LoopCard["loop"]> = {}): LoopCard {
  return {
    loop: {
      id: "target-hidden",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: "/tmp/target" },
      verification: { required: [] },
      persistence: { state_file: ".loop/STATE.md" },
      stop_rules: { max_turns: 3, max_time_minutes: 10, max_retries: 2 },
      ...overrides,
    },
  } as LoopCard;
}

test("buildIntentContract sets target.files when task contains relative paths", () => {
  const contract = buildIntentContract(
    makeCard({
      handoff: {
        task: "审查 packages/server/src/loop/run-service.ts 的停止逻辑",
      },
    }),
    { runId: "run-target", source: "manual" },
  );
  assert.equal(contract.target?.symbols, undefined);
  assert.deepEqual(contract.target, {
    files: ["packages/server/src/loop/run-service.ts"],
  });
});

test("buildIntentContract omits target when task is natural language only", () => {
  const contract = buildIntentContract(
    makeCard({ handoff: { task: "扫描工作区并总结最近的改动" } }),
    { runId: "run-no-target", source: "manual" },
  );
  assert.equal(contract.target, undefined);
});

test("buildIntentContract omits target when handoff.task is absent", () => {
  const contract = buildIntentContract(makeCard(), {
    runId: "run-no-handoff",
    source: "manual",
  });
  assert.equal(contract.target, undefined);
});

test("extractTargetFiles drops URLs and paths with colons", () => {
  assert.deepEqual(
    extractTargetFiles("参考 https://example.com/src/foo.ts"),
    [],
  );
  assert.deepEqual(extractTargetFiles("用 file:///etc/passwd"), []);
});

test("extractTargetFiles does not invent symbols", () => {
  const files = extractTargetFiles(
    "在 packages/server/src/loop/run-service.ts 里检查 handleStop 函数",
  );
  assert.deepEqual(files, ["packages/server/src/loop/run-service.ts"]);
  assert.equal(files.includes("handleStop"), false);
});

test("extractTargetFiles handles empty or whitespace task", () => {
  assert.deepEqual(extractTargetFiles(""), []);
  assert.deepEqual(extractTargetFiles("   \n\t  "), []);
});

test("buildIntentContract deduplicates target.files coming from task", () => {
  const contract = buildIntentContract(
    makeCard({
      handoff: {
        task: "修复 src/a.ts 和 src/a.ts 还有 src/b.tsx",
      },
    }),
    { runId: "run-dedup", source: "manual" },
  );
  assert.deepEqual(contract.target?.files, ["src/a.ts", "src/b.tsx"]);
});
