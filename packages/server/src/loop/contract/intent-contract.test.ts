import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import { buildIntentContract, extractTargetFiles } from "./intent-contract.js";

function makeCard(overrides: Partial<LoopCard["loop"]> = {}): LoopCard {
  return {
    loop: {
      id: "contract-test",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: "/tmp/target" },
      verification: { required: [] },
      persistence: { state_file: ".loop/STATE.md" },
      stop_rules: { max_turns: 3, max_time_minutes: 10, max_retries: 2 },
      ...overrides,
    },
  } as LoopCard;
}

test("no policy block keeps the legacy read-only contract", () => {
  const contract = buildIntentContract(makeCard(), {
    runId: "run-1",
    source: "manual",
  });
  assert.ok(contract.constraints.includes("read_only"));
  assert.match(contract.raw_goal, /read-only scan/);
});

test("bypass approval_mode produces a write-capable contract", () => {
  const contract = buildIntentContract(
    makeCard({ policy: { profile: "loop_bypass", approval_mode: "bypass" } }),
    { runId: "run-2", source: "manual" },
  );
  assert.ok(contract.constraints.includes("workspace_bounded"));
  assert.ok(!contract.constraints.includes("read_only"));
  assert.match(contract.outcome, /允许在工作区内/);
});

test("manual approval_mode degrades to read-only", () => {
  const contract = buildIntentContract(
    makeCard({ policy: { profile: "p", approval_mode: "manual" } }),
    { runId: "run-3", source: "manual" },
  );
  assert.ok(contract.constraints.includes("read_only"));
});

test("handoff.task overrides the generated raw_goal", () => {
  const contract = buildIntentContract(
    makeCard({
      handoff: { task: "Create or update REPORT.md with a workspace summary" },
      policy: { profile: "loop_bypass", approval_mode: "bypass" },
    }),
    { runId: "run-4", source: "manual" },
  );
  assert.equal(
    contract.raw_goal,
    "Create or update REPORT.md with a workspace summary",
  );
});

test("stop_on_repeated_failure projects into contract stop_rules (02 §2)", () => {
  const withRule = buildIntentContract(
    makeCard({
      stop_rules: {
        max_turns: 3,
        max_time_minutes: 10,
        max_retries: 2,
        stop_on_repeated_failure: 2,
      },
    }),
    { runId: "run-5", source: "manual" },
  );
  assert.deepEqual(withRule.stop_rules, {
    repetition: { max_same_failure: 2 },
  });

  // 未声明时不投影 (stop_rules 字段整体缺席)
  const withoutRule = buildIntentContract(makeCard(), {
    runId: "run-6",
    source: "manual",
  });
  assert.equal(withoutRule.stop_rules, undefined);
});

test("extractTargetFiles: 提取相对路径 token，剥离标点并去重", () => {
  const files = extractTargetFiles(
    "修复 `packages/server/src/loop/run-service.ts`, 以及 (src/foo/bar.tsx)。 再看 packages/server/src/loop/run-service.ts 一遍",
  );
  assert.deepEqual(files, [
    "packages/server/src/loop/run-service.ts",
    "src/foo/bar.tsx",
  ]);
});

test("extractTargetFiles: 丢弃绝对路径、Windows 盘符与 .. 逃逸", () => {
  assert.deepEqual(extractTargetFiles("看 /etc/nginx/nginx.conf"), []);
  assert.deepEqual(extractTargetFiles("看 C:/Users/admin/a.ts"), []);
  assert.deepEqual(extractTargetFiles("看 ../outside/secret.ts"), []);
});

test("extractTargetFiles: 无扩展名或无斜杠的 token 不算路径", () => {
  assert.deepEqual(extractTargetFiles("阅读 README 和 src/ 目录"), []);
});

test("extractTargetFiles: 上限 20 个", () => {
  const task = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`).join(" ");
  const files = extractTargetFiles(task);
  assert.equal(files.length, 20);
  assert.equal(files[19], "src/f19.ts");
});

test("buildIntentContract: task 含路径时填 target.files（02 §2）", () => {
  const contract = buildIntentContract(
    makeCard({
      handoff: {
        task: "审查 packages/server/src/loop/run-service.ts 的停止逻辑",
      },
    }),
    { runId: "run-7", source: "manual" },
  );
  // symbols 无从可靠识别，不填
  assert.equal(contract.target?.symbols, undefined);
  assert.deepEqual(contract.target, {
    files: ["packages/server/src/loop/run-service.ts"],
  });
});

test("buildIntentContract: 纯自然语言 task 不设 target 字段（如实缺省）", () => {
  const contract = buildIntentContract(
    makeCard({ handoff: { task: "扫描工作区并总结最近的改动" } }),
    { runId: "run-8", source: "manual" },
  );
  assert.equal(contract.target, undefined);

  // 无 handoff.task 时同样不设
  const noTask = buildIntentContract(makeCard(), {
    runId: "run-9",
    source: "manual",
  });
  assert.equal(noTask.target, undefined);
});

test("buildIntentContract: embeds a multi-subtask plan when provided", () => {
  const plan = {
    plan_id: "plan-1",
    created_at: "2026-07-28T00:00:00.000Z",
    subtasks: [
      {
        id: "subtask-1",
        description: "Create plan.md",
        success_criteria: ["plan.md exists"],
        target_artifacts: ["plan.md"],
      },
      {
        id: "subtask-2",
        description: "Implement src/main.js",
        success_criteria: ["src/main.js exists"],
        target_artifacts: ["src/main.js"],
      },
    ],
  };
  const contract = buildIntentContract(makeCard(), {
    runId: "run-10",
    source: "manual",
    plan,
  });
  assert.deepEqual(contract.plan, plan);
});

test("buildIntentContract: omits plan when not provided", () => {
  const contract = buildIntentContract(makeCard(), {
    runId: "run-11",
    source: "manual",
  });
  assert.equal(contract.plan, undefined);
});
