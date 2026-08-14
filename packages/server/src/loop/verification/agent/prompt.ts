import { createHash } from "node:crypto";
import type {
  IntentContract,
  JudgmentReport,
  VerifierReport,
} from "@yep-anywhere/shared";

/**
 * Verifier Agent prompt（Phase 4 / layered-verifier L4）。
 *
 * 設計口徑（釘死）：
 * - Agent 是 judge，不是 fixer：只讀證據、輸出裁決，不改任何檔案
 *   （session 以 plan mode 啟動，見 run-verifier-agent.ts）。
 * - 對抗性步驟：先以攻擊者視角找「能騙過下層檢查的手法」，再裁決 ——
 *   對齊 verifier_system_design.md 的 Hacker 視角，但不跑完整
 *   Hacker-Fixer 迴圈（那是持續訓練機制，不在單次裁決裡）。
 * - 輸出強制 JSON：由 parse.ts 用 Zod 兜底，無效輸出 = inconclusive。
 */

export interface VerifierAgentBundle {
  run_id: string;
  turn: number;
  requirement: {
    raw_goal: string;
    outcome: string;
    success_criteria: string[];
    constraints: string[];
  };
  /** L1-L3 已執行 verifier 的報告（下層證據）。 */
  prior_reports: VerifierReport[];
  previous_judgment: JudgmentReport | null;
  evidence_refs: {
    diff: string | null;
    stdout: string | null;
    runtime_events: string | null;
    executor_summary: string | null;
  };
  /** 輸入包落盤後的 artifact:// 引用（供 agent 按需回讀）。 */
  input_ref: string;
  workspace_path: string;
  /** 本輪 diff 觸及的檔案路徑清單；空陣列表示無 diff 或尚未判定。 */
  diff_file_paths?: string[];
  /** 本次 judge 實際使用的 provider/model，供審計與 prompt 確認。 */
  judge?: {
    provider: string | null;
    model: string | null;
    env_override: string | null;
  };
}

const RUBRIC = [
  { criterion: "需求對齊", weight: 0.4 },
  { criterion: "邊界覆蓋", weight: 0.3 },
  { criterion: "風格一致性", weight: 0.2 },
  { criterion: "無邏輯漏洞", weight: 0.1 },
];

/** L4 prompt inline evidence cap. Larger evidence stays in artifacts. */
export const MAX_VERIFIER_INPUT_CHARS = 64_000;

const DOCS_ONLY_FILE_RE =
  /(^|\/)(docs|documentation)\/|\.md$|\.markdown$|\.adoc$|\.rst$|\.txt$|(^|\/)(LICENSE|CHANGELOG|CHANGES|NOTICE|CONTRIBUTING|README)(\.|$)|\.editorconfig$|\.gitattributes$|\.gitignore$/i;

export function isDocsOnlyFilePaths(paths: string[]): boolean {
  if (paths.length === 0) {
    return false;
  }
  return paths.every((filePath) =>
    DOCS_ONLY_FILE_RE.test(filePath.replace(/\\/g, "/")),
  );
}

function boundedJson(value: unknown, label: string): unknown {
  const raw = JSON.stringify(value, null, 2);
  if (raw.length <= MAX_VERIFIER_INPUT_CHARS) {
    return value;
  }
  return {
    truncated: true,
    label,
    original_chars: raw.length,
    sha256: createHash("sha256").update(raw).digest("hex"),
    instruction: `完整內容已落盤並以 artifact ref 提供；請回讀 ${label} 的完整 artifact，不要猜測。`,
  };
}

export function buildVerifierAgentPrompt(bundle: VerifierAgentBundle): string {
  return [
    "你是 Verifier Agent（L4 語義評判）。你是 judge，不是 fixer：只能閱讀證據、輸出裁決，嚴禁修改任何檔案。",
    "",
    "## 裁決流程（必須依序）",
    "1. 攻擊者視角：假設本輪產出試圖騙過下層檢查（L1-L3），列出最多 3 個最可能的欺騙手法或未覆蓋的漏洞。",
    "2. 按 Rubric 逐維度評分：",
    ...RUBRIC.map((r) => `   - ${r.criterion}（權重 ${r.weight}）`),
    "3. 給出總裁決。",
    "",
    "## 需求與驗收標準",
    JSON.stringify(boundedJson(bundle.requirement, "requirement"), null, 2),
    "",
    "## 下層檢查報告（L1-L3，已通過/已執行）",
    JSON.stringify(boundedJson(bundle.prior_reports, "prior_reports"), null, 2),
    "",
    "## 上一輪裁決（如有；不要重複已解決的問題）",
    JSON.stringify(
      boundedJson(bundle.previous_judgment, "previous_judgment"),
      null,
      2,
    ),
    "",
    "## 證據引用（可用 Read/Grep/Glob 回讀 workspace 與 artifact 內容）",
    JSON.stringify(boundedJson(bundle.evidence_refs, "evidence_refs"), null, 2),
    `輸入包: ${bundle.input_ref}`,
    `workspace: ${bundle.workspace_path}`,
    "",
    "## 輸出格式（只輸出這個 JSON，不要任何前後文字）",
    "```json",
    JSON.stringify(
      {
        status: "passed | failed | inconclusive",
        recommendation: "stop | retry | escalate",
        confidence: "0.0 ~ 1.0",
        requires_human: "boolean",
        score: "0.0 ~ 1.0（Rubric 加權和）",
        unresolved_risks: ["..."],
        issues: [
          {
            severity: "critical | major | minor | info",
            message: "問題描述",
            location: { file: "path", line: 0 },
            suggestion: "修復建議",
          },
        ],
        suggested_fix: "整體修復方向（可空字串）",
        adversarial_findings: ["攻擊者視角發現（步驟 1）"],
        human_reasons: [
          {
            code: "duplicate_pr",
            message: "例如：存在同範圍 open PR #123，發布前需人工決定。",
            evidence_refs: ["https://github.com/owner/repo/pull/123"],
          },
        ],
      },
      null,
      2,
    ),
    "```",
    "",
    "裁決口徑：下層已 failed 的問題不重複判；你的職責是下層檢查看不到的語義層（需求對齊/邊界/風格/邏輯漏洞）。證據不足 = inconclusive，不要猜。",
    "",
    "## 任務類型分流",
    `diff_file_paths: ${JSON.stringify(bundle.diff_file_paths ?? [])}`,
    isDocsOnlyFilePaths(bundle.diff_file_paths ?? [])
      ? [
          "本輪變更僅觸及文檔/標記/許可證類檔案，沒有可執行代碼改動。",
          "docs-only 裁決標準改為：",
          "  1. 檔案確實落盤且位置符合意圖；",
          "  2. 內容與 intent contract 的需求對齊；",
          "  3. 沒有混入代碼語義改動。",
          "三條滿足即可給 passed，不得以「沒有測試證據」為由給 inconclusive。",
          "若你發現文件路徑分類不確定、包含代碼或無法確認三條，回到上方代碼口徑從嚴裁決。",
        ].join("\n")
      : [
          "本輪包含代碼改動或無法確定為 docs-only。",
          "維持代碼口徑：證據不足 = inconclusive，不要猜；絕不因檔案看起來像文檔就放寬。",
        ].join("\n"),
  ].join("\n");
}

/**
 * Corrective retry prompt for structured output recovery. The original
 * requirement is kept verbatim so the retry is a fresh, self-contained
 * session rather than an implicit conversation continuation.
 */
export function buildVerifierAgentRecoveryPrompt(input: {
  basePrompt: string;
  previousOutput: string;
  validationError: string;
}): string {
  const previous = input.previousOutput.replace(/```/g, "'''").slice(0, 8_000);
  return [
    input.basePrompt,
    "",
    "## Previous output was rejected",
    "Your previous output was not accepted as valid JSON. Do not repeat or explain it.",
    "Return ONLY the JSON object described above, with no prose, markdown, or extra text.",
    "",
    `Validation error: ${input.validationError}`,
    "",
    "Previous output:",
    "```text",
    previous || "(empty)",
    "```",
  ].join("\n");
}

/** 從 contract 投影需求塊（bundle 組裝用）。 */
export function requirementFromContract(
  contract: IntentContract,
): VerifierAgentBundle["requirement"] {
  return {
    raw_goal: contract.raw_goal,
    outcome: contract.outcome,
    success_criteria: contract.success_criteria,
    constraints: contract.constraints,
  };
}
