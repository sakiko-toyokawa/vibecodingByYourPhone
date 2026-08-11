/**
 * Independent policy reviewer.
 *
 * When the deterministic arbiter cannot safely auto-approve a review_or_policy
 * action, a separate read-only agent session reviews the exact tool call
 * against the intent contract. It is independent from the maker because:
 *
 *  - it gets a fresh session with no maker transcript;
 *  - it runs in plan/read-only mode and cannot modify files or run Bash;
 *  - its verdict is parsed as strict JSON and failures fail closed.
 *
 * The reviewer is an escalation lane, not a second executor. It never sees
 * a hard gate as eligible; hard gates continue to require a human.
 */

import type {
  IntentContract,
  LoopCard,
  ProviderName,
} from "@yep-anywhere/shared";
import { z } from "zod";
import type { Process } from "../../supervisor/Process.js";
import type { Supervisor } from "../../supervisor/Supervisor.js";
import { resolveAdapterPolicy } from "../assembly/adapter-policy.js";
import type { RuntimeInput } from "../assembly/runtime-input.js";
import { loopRuntime } from "../run/workspace.js";
import type { RunLedgerStore } from "../state/run-ledger-store.js";
import type { ToolCallClassification } from "./classify.js";

export type PolicyReviewDecision = "allow" | "deny" | "hard_gate";

export interface PolicyReviewRequest {
  runId: string;
  loopId: string;
  turn: number;
  toolName: string;
  input: unknown;
  classification: ToolCallClassification;
  workspacePath: string;
  contract?: IntentContract | null;
}

export interface PolicyReviewResult {
  decision: PolicyReviewDecision;
  reason: string;
  confidence: number;
  evidenceRefs: string[];
}

export interface PolicyReviewAgentContext {
  card: LoopCard;
  contract: IntentContract | null;
  input: RuntimeInput;
  runId: string;
  loopId: string;
  turn: number;
}

export interface RunPolicyReviewAgentDeps {
  supervisor: Supervisor;
  runLedgerStore: RunLedgerStore;
}

const DEFAULT_REVIEW_TIMEOUT_MS = 120_000;

const POLICY_REVIEW_OUTPUT_SCHEMA = z.object({
  decision: z.enum(["allow", "deny", "hard_gate"]),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.array(z.string()).optional(),
});

function redactSensitiveInput(input: unknown): unknown {
  try {
    const raw = JSON.stringify(input ?? {});
    const redacted = raw
      .replace(
        /("(?:token|access_token|api_key|apikey|password|secret|authorization)"\s*:\s*")[^"]+/gi,
        "$1<redacted>",
      )
      .replace(
        /\b(?:ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+)\b/gi,
        "<redacted>",
      );
    return JSON.parse(redacted) as unknown;
  } catch {
    return { redacted: true };
  }
}

export function buildPolicyReviewPrompt(
  request: PolicyReviewRequest,
  inputRef: string,
): string {
  const contract = request.contract;
  return [
    "你是独立政策审查员，不是执行 agent。",
    "",
    "你只审查一次工具调用是否可以被无人值守 loop 执行。你不能修改文件，不能运行 Bash，不能批准硬闸门动作。",
    "",
    "## 审查流程",
    "1. 先读契约与成功标准，判断该工具调用是否在任务范围内。",
    "2. 再读 workspace 中的相关文件（Read/Grep/Glob），确认路径、命令与现状。",
    "3. 最后给结论。证据不足时选择 hard_gate，不要猜。",
    "",
    "## 判断标准",
    "- allow：动作明确属于契约目标、位于 workspace 内、本地可回滚，并且没有外部不可逆副作用。",
    "- deny：动作明显违反契约、超出 workspace、或会造成不可逆外部后果。",
    "- hard_gate：动作可能合理但证据不足、边界模糊、涉及外部可见副作用、或需要人工判断。",
    "- merge / deploy / delete / publish / bill / notify / close 一律 hard_gate，不能 allow。",
    "",
    "## 任务契约",
    JSON.stringify(
      contract
        ? {
            raw_goal: contract.raw_goal,
            outcome: contract.outcome,
            success_criteria: contract.success_criteria,
            constraints: contract.constraints,
            security_level: contract.security_level,
          }
        : "contract unavailable",
      null,
      2,
    ),
    "",
    "## 待审查工具调用",
    JSON.stringify(
      {
        tool: request.toolName,
        input: redactSensitiveInput(request.input),
        classification: {
          action: request.classification.action,
          risk: request.classification.risk,
          summary: request.classification.summary,
          writeTargets: request.classification.writeTargets,
        },
      },
      null,
      2,
    ),
    "",
    `输入包: ${inputRef}`,
    `workspace: ${request.workspacePath}`,
    "",
    "## 输出格式（只输出这个 JSON，不要任何前后文字）",
    "```json",
    JSON.stringify(
      {
        decision: "allow | deny | hard_gate",
        reason: "一句话说明",
        confidence: "0.0 ~ 1.0",
        evidence: ["你检查过的 artifact/workspace 路径"],
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

function extractJson(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(fenced.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

export function parsePolicyReviewOutput(
  text: string,
  outputRef: string,
): PolicyReviewResult {
  const parsed = POLICY_REVIEW_OUTPUT_SCHEMA.safeParse(extractJson(text));
  if (!parsed.success) {
    return {
      decision: "hard_gate",
      reason: "policy reviewer produced invalid output; escalating to human",
      confidence: 0,
      evidenceRefs: [outputRef],
    };
  }
  return {
    decision: parsed.data.decision,
    reason: parsed.data.reason,
    confidence: parsed.data.confidence ?? 0.5,
    evidenceRefs: [outputRef, ...(parsed.data.evidence ?? [])],
  };
}

function watchReviewerProcess(
  proc: Process,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve) => {
    let finalText = "";
    let settled = false;

    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      void proc.abort().catch(() => {});
      resolve(finalText);
    };

    const timer = setTimeout(settle, timeoutMs);
    timer.unref();

    const unsubscribe = proc.subscribe((event) => {
      if (event.type === "message") {
        const message = event.message;
        if (message.type === "result" && typeof message.result === "string") {
          finalText = message.result;
          settle();
        } else if (message.type === "error") {
          settle();
        }
      } else if (
        event.type === "state-change" &&
        event.state.type === "waiting-input"
      ) {
        proc.respondToInput(
          event.state.request.id,
          "deny",
          undefined,
          "Policy reviewer is read-only; no tool approval requests are allowed.",
        );
      } else if (
        event.type === "complete" ||
        event.type === "terminated" ||
        event.type === "error"
      ) {
        settle();
      }
    });
  });
}

export async function runPolicyReviewAgent(
  deps: RunPolicyReviewAgentDeps,
  ctx: PolicyReviewAgentContext,
  request: PolicyReviewRequest,
): Promise<PolicyReviewResult> {
  const suffix = ctx.turn === 1 ? "" : `-turn${ctx.turn}`;
  const inputName = `policy-review-input${suffix}.json`;
  const outputName = `policy-review-output${suffix}.log`;

  const bundle = {
    run_id: ctx.runId,
    loop_id: ctx.loopId,
    turn: ctx.turn,
    tool: request.toolName,
    input: redactSensitiveInput(request.input),
    classification: request.classification,
    contract: ctx.contract
      ? {
          raw_goal: ctx.contract.raw_goal,
          constraints: ctx.contract.constraints,
          success_criteria: ctx.contract.success_criteria,
          security_level: ctx.contract.security_level,
        }
      : null,
  };
  await deps.runLedgerStore.writeArtifact(
    ctx.runId,
    inputName,
    `${JSON.stringify(bundle, null, 2)}\n`,
  );
  const inputRef = `artifact://${ctx.runId}/${inputName}`;

  let output = "";
  try {
    const adapterPolicy = resolveAdapterPolicy(ctx.input.adapterPolicy);
    const reviewerEnv: Record<string, string> = {};
    if (ctx.input.env) {
      for (const [key, value] of Object.entries(ctx.input.env)) {
        if (key !== "GH_TOKEN" && key !== "GITHUB_TOKEN") {
          reviewerEnv[key] = value;
        }
      }
    }
    const result = await deps.supervisor.startSession(
      ctx.input.cwd,
      {
        text: buildPolicyReviewPrompt(request, inputRef),
        mode: "plan",
      },
      "plan",
      {
        permissions: {
          deny: [
            "Edit",
            "Write",
            "NotebookEdit",
            "MultiEdit",
            "Bash",
            "AskUserQuestion",
            "ExitPlanMode",
          ],
        },
        env: reviewerEnv,
        providerName: loopRuntime(ctx.card)?.provider as
          | ProviderName
          | undefined,
        model: adapterPolicy.model ?? loopRuntime(ctx.card)?.model,
      },
    );
    if ("error" in result || "queued" in result) {
      output = "policy reviewer could not start: supervisor unavailable";
    } else {
      output = await watchReviewerProcess(
        result as Process,
        adapterPolicy.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
      );
    }
  } catch (error) {
    output =
      error instanceof Error
        ? error.message
        : `policy reviewer failed: ${error}`;
  }

  await deps.runLedgerStore.writeArtifact(ctx.runId, outputName, output);
  return parsePolicyReviewOutput(
    output,
    `artifact://${ctx.runId}/${outputName}`,
  );
}
