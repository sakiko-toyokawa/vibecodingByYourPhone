import type { IntentContract, LoopCard } from "@yep-anywhere/shared";
import { z } from "zod";
import type { Process } from "../../supervisor/Process.js";
import type { Supervisor } from "../../supervisor/Supervisor.js";
import { buildIntentContract } from "./intent-contract.js";
import { matchIntentTemplate } from "./intent-templates.js";

/**
 * 意圖理解 Agent（P5）：把 LoopCard handoff.task 的自然語言需求轉成
 * 結構化 IntentContract。
 *
 * 安全口徑（釘死）：
 * - Agent 只能提議**語義欄位**（outcome / success_criteria / constraints /
 *   task_type / target.files）；budget、security_level、stop_rules 永遠由
 *   確定性裝配從 card 投影 —— 不讓模型給自己放權或加預算。
 * - Agent 輸出只是候選：先過 Zod 閘門，解析失敗 = 回退確定性裝配
 *   （generated_by 不落在 contract 上，行為與未開啟一致）。
 * - Agent 產生的合約 confirmed_by_human=false：run 在首輪執行前泊入
 *   needs_human（見 turn-loop 的意圖閘門），人工 approve 視為確認。
 * - task_type 命中範本庫時不走 agent（範本即人審過的合約，省一次調用）。
 */

const AgentIntentSchema = z.object({
  understanding_summary: z.string(),
  outcome: z.string(),
  success_criteria: z.array(z.string()).min(1),
  constraints: z.array(z.string()).default([]),
  task_type: z
    .object({
      primary: z.string(),
      confidence: z.number().min(0).max(1),
    })
    .optional(),
  target_files: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  clarification_questions: z.array(z.string()).default([]),
});

export interface IntentUnderstandingDeps {
  supervisor: Supervisor;
  watchProcess: (
    runId: string,
    proc: Process,
    opts: { timeoutMs?: number },
  ) => Promise<{ ok: boolean; finalText: string; error?: string }>;
  /** Agent 調用逾時（預設 3 分鐘 —— 意圖理解是短任務）。 */
  timeoutMs?: number;
}

const DEFAULT_INTENT_AGENT_TIMEOUT_MS = 3 * 60 * 1000;

function buildIntentAgentPrompt(task: string, card: LoopCard): string {
  return [
    "你是意圖理解 Agent。把使用者的自然語言任務轉成結構化合約草案。",
    "你只能提議語義欄位；預算與安全等級由系統決定，與你無關。",
    "不確定的地方寫進 clarification_questions，不要猜。",
    "",
    `## Loop: ${card.loop.id}`,
    "## 任務原文",
    task,
    card.loop.handoff?.default_task_type
      ? `\n## 宣告的任務型別: ${card.loop.handoff.default_task_type}`
      : "",
    "",
    "## 輸出格式（只輸出這個 JSON，不要任何前後文字）",
    "```json",
    JSON.stringify(
      {
        understanding_summary: "一句話說明你理解的任務意圖",
        outcome: "任務完成後應產生的結果",
        success_criteria: ["可檢查的驗收標準（至少一條）"],
        constraints: ["約束條件（可空陣列）"],
        task_type: { primary: "任務型別", confidence: 0.0 },
        target_files: ["任務明確指向的相對路徑檔案（可空陣列）"],
        assumptions: ["你做的假設（可空陣列）"],
        clarification_questions: ["需要向人澄清的問題（可空陣列）"],
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

/** 從 agent 文本提取 JSON（與 verifier agent 同款口徑）。 */
function extractJson(text: string): unknown | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (let i = fenced.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(fenced[i]?.[1] ?? "");
    } catch {
      // try next block
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

export interface BuildContractOptions {
  runId: string;
  source: "cron" | "manual";
  plan?: IntentContract["plan"];
}

/**
 * 意圖理解入口：範本命中 → 範本覆蓋（已確認）；否則 agent → 草案
 * （未確認）；agent 失敗 → null（呼叫方回退確定性裝配）。
 */
export async function buildIntentContractWithUnderstanding(
  card: LoopCard,
  options: BuildContractOptions,
  deps: IntentUnderstandingDeps,
): Promise<IntentContract | null> {
  const task = card.loop.handoff?.task;
  if (!task) {
    return null;
  }

  // 1. 範本命中：免 agent、視為已確認。
  const template = matchIntentTemplate(card.loop.handoff?.default_task_type);
  if (template) {
    const base = buildIntentContract(card, options);
    return {
      ...base,
      outcome: template.outcome,
      success_criteria: template.success_criteria,
      constraints: [...new Set([...base.constraints, ...template.constraints])],
      intent_understanding: {
        original_prompt: task,
        understanding_summary: `task_type '${template.task_type}' 命中合約範本`,
        assumptions: [],
        clarification_questions: [],
        generated_by: "template",
        confirmed_by_human: true,
      },
    };
  }

  // 2. Agent 路徑
  const workspacePath = card.loop.workspace.path;
  if (!workspacePath) {
    return null;
  }
  let output = "";
  try {
    const runtime = card.loop.runtime;
    const result = await deps.supervisor.startSession(
      workspacePath,
      { text: buildIntentAgentPrompt(task, card), mode: "plan" },
      "plan",
      {
        providerName: runtime?.provider as
          | import("@yep-anywhere/shared").ProviderName
          | undefined,
        model: runtime?.model,
      },
    );
    if ("error" in result || "queued" in result) {
      return null;
    }
    const watched = await deps.watchProcess(options.runId, result as Process, {
      timeoutMs: deps.timeoutMs ?? DEFAULT_INTENT_AGENT_TIMEOUT_MS,
    });
    if (!watched.ok) {
      return null;
    }
    output = watched.finalText;
  } catch {
    return null;
  }

  const raw = extractJson(output);
  const parsed = raw === null ? null : AgentIntentSchema.safeParse(raw);
  if (!parsed || !parsed.success) {
    return null;
  }
  const intent = parsed.data;

  // 3. 合併：確定性底座（budget / security_level / stop_rules）+ agent 語義欄位
  const base = buildIntentContract(card, options);
  return {
    ...base,
    raw_goal: task,
    outcome: intent.outcome,
    success_criteria: intent.success_criteria,
    constraints: [...new Set([...base.constraints, ...intent.constraints])],
    task_type: intent.task_type
      ? {
          primary: intent.task_type.primary,
          confidence: intent.task_type.confidence,
          requires_clarification: intent.clarification_questions.length > 0,
        }
      : base.task_type,
    ...(intent.target_files.length > 0
      ? { target: { files: intent.target_files } }
      : {}),
    intent_understanding: {
      original_prompt: task,
      understanding_summary: intent.understanding_summary,
      assumptions: intent.assumptions,
      clarification_questions: intent.clarification_questions,
      generated_by: "agent",
      confirmed_by_human: false,
    },
  };
}
