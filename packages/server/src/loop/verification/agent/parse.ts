import type { VerifierReport } from "@yep-anywhere/shared";
import { VerifierReportSchema } from "@yep-anywhere/shared";
import { z } from "zod";

/**
 * Verifier Agent 輸出解析與兜底（Phase 4）。
 *
 * 核心禁忌的執行面：「不讓模型當 verifier」意味著 —— 模型輸出只是
 * **候選裁決**，必須過 Zod 這道確定性閘門才能進賬本。runner 會先做
 * repair / corrective retry；仍然失敗才降級為 inconclusive + escalate，
 * 絕不讓未驗證的自然語言直接影響控制面決策。
 */

const AgentVerdictSchema = z.object({
  status: z.enum(["passed", "failed", "inconclusive"]),
  recommendation: z.enum(["stop", "retry", "escalate"]),
  confidence: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() !== "" ? Number(value) : value,
    z.number().min(0).max(1),
  ),
  requires_human: z.boolean().default(false),
  score: z
    .preprocess(
      (value) =>
        typeof value === "string" && value.trim() !== ""
          ? Number(value)
          : value,
      z.number().min(0).max(1),
    )
    .optional(),
  unresolved_risks: z.array(z.string()).default([]),
  issues: z
    .array(
      z.object({
        severity: z.enum(["critical", "major", "minor", "info"]),
        message: z.string(),
        location: z
          .object({
            file: z.string(),
            line: z
              .preprocess(
                (value) =>
                  typeof value === "string" && value.trim() !== ""
                    ? Number(value)
                    : value,
                z.number().optional(),
              )
              .optional(),
            column: z
              .preprocess(
                (value) =>
                  typeof value === "string" && value.trim() !== ""
                    ? Number(value)
                    : value,
                z.number().optional(),
              )
              .optional(),
          })
          .optional(),
        suggestion: z.string().optional(),
      }),
    )
    .default([]),
  suggested_fix: z.string().optional(),
  adversarial_findings: z.array(z.string()).default([]),
});

export type AgentVerdict = z.infer<typeof AgentVerdictSchema>;

/**
 * Repair the most common LLM JSON damage without guessing semantics:
 * strip a surrounding object and remove trailing commas. Anything deeper is
 * left for a retry with the validation error, not for speculative repair.
 */
export function repairJsonText(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  const candidate = text
    .slice(start, end + 1)
    .replace(/,\s*([}\]])/g, "$1")
    .trim();
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/** 從 agent 文本提取 JSON：優先最後一個 ```json fenced block，再回落全文。 */
export function extractJson(text: string): unknown | null {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    candidates.push(trimmed);
  }
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (let i = fenced.length - 1; i >= 0; i -= 1) {
    candidates.push(fenced[i]?.[1] ?? "");
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    candidates.push(text.slice(start, end + 1));
  }
  const repaired = repairJsonText(text);
  if (repaired) {
    candidates.push(repaired);
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Validate one agent output. Returns the parsed verdict or a deterministic
 * validation error suitable for a corrective retry prompt.
 */
export function parseVerifierAgentVerdict(
  text: string,
): { ok: true; value: AgentVerdict } | { ok: false; error: string } {
  const raw = extractJson(text);
  if (raw === null) {
    return {
      ok: false,
      error: "no JSON object found in agent output",
    };
  }
  const parsed = AgentVerdictSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    };
  }
  return { ok: true, value: parsed.data };
}

export interface ParseAgentOutputOptions {
  /** 本輪 agent 輸出落盤後的 artifact ref（進 evidence_refs）。 */
  outputRef: string;
  /** 上層提供的補充證據（input bundle ref 等）。 */
  extraEvidenceRefs?: string[];
}

/**
 * 解析 agent 輸出為 VerifierReport。最終失敗時回 inconclusive + escalate
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

  const verdict = parseVerifierAgentVerdict(text);
  if (!verdict.ok) {
    return VerifierReportSchema.parse({
      verifier_phase: "review",
      status: "inconclusive",
      evidence_refs: baseEvidence,
      unresolved_risks: [
        `verifier agent 輸出無法解析為合法裁決 JSON（${verdict.error}；已降級 inconclusive；原始輸出見 evidence）`,
      ],
      recommendation: "escalate",
      confidence: 0.1,
      requires_human: false,
    });
  }

  // 對抗性發現進 risks（不單獨設欄位 —— VerifierReport 沒有該欄，
  // 放 unresolved_risks 讓 retry context 與人工都能看到）。
  const adversarialRisks = verdict.value.adversarial_findings.map(
    (finding) => `adversarial: ${finding}`,
  );

  return VerifierReportSchema.parse({
    verifier_phase: "review",
    status: verdict.value.status,
    evidence_refs: baseEvidence,
    unresolved_risks: [...verdict.value.unresolved_risks, ...adversarialRisks],
    recommendation: verdict.value.recommendation,
    confidence: verdict.value.confidence,
    requires_human: verdict.value.requires_human,
    ...(verdict.value.score !== undefined
      ? { score: verdict.value.score }
      : {}),
    issues: verdict.value.issues.map((issue, index) => ({
      id: `L4-${String(index + 1).padStart(3, "0")}`,
      severity: issue.severity,
      layer: "review" as const,
      ...(issue.location ? { location: issue.location } : {}),
      message: issue.message,
      ...(issue.suggestion ? { suggestion: issue.suggestion } : {}),
    })),
    ...(verdict.value.suggested_fix
      ? { suggested_fix: verdict.value.suggested_fix }
      : {}),
  });
}
