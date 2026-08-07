import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import { matchIntentTemplate } from "./intent-templates.js";
import { buildIntentContractWithUnderstanding } from "./intent-understanding-agent.js";

function makeCard(overrides: Partial<LoopCard["loop"]> = {}): LoopCard {
  return {
    loop: {
      id: "loop-intent",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: "/tmp/ws" },
      handoff: { task: "把登入頁的表單驗證補上" },
      verification: { required: ["static"] },
      persistence: { state_file: "state/loop-intent.json" },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 2 },
      ...overrides,
    },
  } as LoopCard;
}

const AGENT_JSON = JSON.stringify({
  understanding_summary: "補登入表單驗證",
  outcome: "登入表單具備前端驗證並產出報告",
  success_criteria: ["表單驗證邏輯存在", "相關測試通過"],
  constraints: ["不改公共 API"],
  task_type: { primary: "maintenance", confidence: 0.9 },
  target_files: ["src/pages/login.tsx"],
  assumptions: ["使用既有表單元件"],
  clarification_questions: [],
});

function makeDeps(output: string, ok = true) {
  return {
    supervisor: {
      startSession: async () => ({ fake: true }),
    } as never,
    watchProcess: async () => ({ ok, finalText: output }),
  };
}

test("matchIntentTemplate: 命中/未命中", () => {
  assert.ok(matchIntentTemplate("maintenance"));
  assert.equal(matchIntentTemplate("nonexistent"), null);
  assert.equal(matchIntentTemplate(undefined), null);
});

test("範本命中: 不走 agent, confirmed_by_human=true, budget 不被覆蓋", async () => {
  let agentCalled = false;
  const card = makeCard({
    handoff: { task: "夜間依賴掃描", default_task_type: "dependency_update" },
  });
  const contract = await buildIntentContractWithUnderstanding(
    card,
    { runId: "run-1", source: "manual" },
    {
      supervisor: {
        startSession: async () => {
          agentCalled = true;
          return { fake: true };
        },
      } as never,
      watchProcess: async () => ({ ok: true, finalText: "" }),
    },
  );
  assert.ok(contract);
  assert.equal(agentCalled, false);
  assert.equal(contract?.intent_understanding?.generated_by, "template");
  assert.equal(contract?.intent_understanding?.confirmed_by_human, true);
  // budget 由 card 投影, 範本/agent 都不得覆蓋
  assert.equal(contract?.budget.max_turns, 3);
  assert.equal(contract?.budget.max_retries, 2);
});

test("agent 路徑: 合法 JSON 合併語義欄位, confirmed_by_human=false", async () => {
  const card = makeCard();
  const contract = await buildIntentContractWithUnderstanding(
    card,
    { runId: "run-2", source: "manual" },
    makeDeps(AGENT_JSON),
  );
  assert.ok(contract);
  assert.equal(contract?.intent_understanding?.generated_by, "agent");
  assert.equal(contract?.intent_understanding?.confirmed_by_human, false);
  assert.equal(contract?.outcome, "登入表單具備前端驗證並產出報告");
  assert.deepEqual(contract?.target?.files, ["src/pages/login.tsx"]);
  // 確定性底座不被覆蓋
  assert.equal(contract?.security_level, "read_only");
  assert.equal(contract?.budget.max_turns, 3);
  // 約束合併去重
  assert.ok(contract?.constraints.includes("read_only"));
  assert.ok(contract?.constraints.includes("不改公共 API"));
});

test("agent 輸出非法 → null (呼叫方回退確定性裝配)", async () => {
  const card = makeCard();
  const contract = await buildIntentContractWithUnderstanding(
    card,
    { runId: "run-3", source: "manual" },
    makeDeps("我覺得這個任務很簡單"),
  );
  assert.equal(contract, null);
});

test("agent 进程失敗 → null", async () => {
  const card = makeCard();
  const contract = await buildIntentContractWithUnderstanding(
    card,
    { runId: "run-4", source: "manual" },
    makeDeps("", false),
  );
  assert.equal(contract, null);
});

test("無 handoff.task → null", async () => {
  const card = makeCard({ handoff: {} });
  const contract = await buildIntentContractWithUnderstanding(
    card,
    { runId: "run-5", source: "manual" },
    makeDeps(AGENT_JSON),
  );
  assert.equal(contract, null);
});
