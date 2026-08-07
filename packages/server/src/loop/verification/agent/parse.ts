import type { VerifierReport } from "@yep-anywhere/shared";
import { VerifierReportSchema } from "@yep-anywhere/shared";
import { z } from "zod";

/**
 * Verifier Agent 輸出解析與兜底（Phase 4）。
 *
 * 核心禁忌的執行面：「不讓模型當 verifier」意味著 —— 模型輸出只是
 * **候選裁決**，必須過 Zod 這道確定性閘門才能進賬本。任何解析失敗
 * （非 JSON、欄位缺失、枚舉越界）一律降級為 inconclusive + escalate，
 * 絕不讓未驗證的自然語言直接影響控制面決策。
 */

const AgentVerdictSchema = z.object({
  status: z.enum(["passed", "failed", "inconclusive"]),
  recommendation: z.enum(["stop", "retry", "escalate"]),
  confidence: z.number().min(0).max(1),
  requires_human: z.boolean().default(false),
  score: z.number().min(0).max(1).optional(),
  unresolved_risks: z.array(z.string()).default([]),
  issues: z
    .array(
      z.object({
        severity: z.enum(["critical", "major", "minor", "info"]),
        message: z.string(),
        location: z
          .object({
            file: z.string(),
            line: z.number().optional(),
            column: z.number().optional(),
          })
          .optional(),
        suggestion: z.string().optional(),
      }),
    )
    .default([]),
  suggested_fix: z.string().optional(),
  adversarial_findings: z.array(z.string()).default([]),
});

/** 從 agent 文本提取 JSON：優先最後一個 ```json fenced block，回落全文。 */
export function extractJson(text: string): unknown | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (let i = fenced.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(fenced[i]?.[1] ?? "");
    } catch {
      // try next block
    }
  }
  // 回落：第一個 { 到最後一個 }
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

export interface ParseAgentOutputOptions {
  /** 本輪 agent 輸出落盤後的 artifact ref（進 evidence_refs）。 */
  outputRef: string;
  /** 上層提供的補充證據（input bundle ref 等）。 */
  extraEvidenceRefs?: string[];
}

/**
 * 解析 agent 輸出為 VerifierReport。失敗時回 inconclusive + escalate
 * 的兜底報告（帶原始輸出 ref，供人工排查）。
 */
export function parseVerifierAgentOutput(
  text: string,
  options: ParseAgentOutputOptions,
): VerifierReport {
  const baseEvidence = [
    options.outputRef,
    ...(options.extraEvidenceRefs ?? []),
  ];

  const raw = extractJson(text);
  const parsed = raw === null ? null : AgentVerdictSchema.safeParse(raw);
  if (!parsed || !parsed.success) {
    return VerifierReportSchema.parse({
      verifier_phase: "review",
      status: "inconclusive",
      evidence_refs: baseEvidence,
      unresolved_risks: [
        "verifier agent 輸出無法解析為合法裁決 JSON（已降級 inconclusive；原始輸出見 evidence）",
      ],
      recommendation: "escalate",
      confidence: 0.1,
      requires_human: false,
    });
  }

  const verdict = parsed.data;
  // 對抗性發現進 risks（不單獨設欄位 —— VerifierReport 沒有該欄，
  // 放 unresolved_risks 讓 retry context 與人工都能看到）。
  const adversarialRisks = verdict.adversarial_findings.map(
    (finding) => `adversarial: ${finding}`,
  );

  return VerifierReportSchema.parse({
    verifier_phase: "review",
    status: verdict.status,
    evidence_refs: baseEvidence,
    unresolved_risks: [...verdict.unresolved_risks, ...adversarialRisks],
    recommendation: verdict.recommendation,
    confidence: verdict.confidence,
    requires_human: verdict.requires_human,
    ...(verdict.score !== undefined ? { score: verdict.score } : {}),
    issues: verdict.issues.map((issue, index) => ({
      id: `L4-${String(index + 1).padStart(3, "0")}`,
      severity: issue.severity,
      layer: "review" as const,
      ...(issue.location ? { location: issue.location } : {}),
      message: issue.message,
      ...(issue.suggestion ? { suggestion: issue.suggestion } : {}),
    })),
    ...(verdict.suggested_fix ? { suggested_fix: verdict.suggested_fix } : {}),
  });
}
