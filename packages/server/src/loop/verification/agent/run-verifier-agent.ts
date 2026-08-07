import type { VerifierReport } from "@yep-anywhere/shared";
import type { Process } from "../../../supervisor/Process.js";
import type { Supervisor } from "../../../supervisor/Supervisor.js";
import { resolveAdapterPolicy } from "../../assembly/adapter-policy.js";
import type { RunExecutionContext } from "../../run/types.js";
import { loopRuntime } from "../../run/workspace.js";
import type { RunLedgerStore } from "../../state/run-ledger-store.js";
import type { ReviewAgentContext } from "../verify-run.js";
import { parseVerifierAgentOutput } from "./parse.js";
import { buildVerifierAgentPrompt, requirementFromContract } from "./prompt.js";

/**
 * Verifier Agent runner（Phase 4 / L4 LLM-as-Judge）。
 *
 * - Read-only：session 以 "plan" mode 啟動（唯讀工具自動批准，寫工具
 *   不給）——Verifier 不能修改 Maker 的輸出，這是硬約束。
 * - Fresh context：新 session，只帶 bundle 裡的最小判斷資訊，不帶
 *   Maker 的完整對話歷史。
 * - 模型：沿用 card runtime / adapter_policy 的 model 覆蓋；與 Maker
 *   不同家族的「交叉評判」是部署配置問題（card.loop.runtime 指定），
 *   不在此硬編碼。
 * - 輸出：Zod 兜底（parse.ts）；agent 崩潰/逾時/無輸出 = inconclusive +
 *   escalate，絕不讓未驗證文本進賬本。
 */

export interface RunVerifierAgentDeps {
  supervisor: Supervisor;
  runLedgerStore: RunLedgerStore;
  watchProcess: (
    runId: string,
    proc: Process,
    opts: { timeoutMs?: number },
  ) => Promise<{
    ok: boolean;
    finalText: string;
    error?: string;
  }>;
}

export async function runVerifierAgent(
  deps: RunVerifierAgentDeps,
  ctx: RunExecutionContext,
  agentCtx: ReviewAgentContext,
): Promise<VerifierReport> {
  const { runId } = agentCtx;
  const suffix = agentCtx.turn === 1 ? "" : `-turn${agentCtx.turn}`;
  const inputName = `verifier-agent-input${suffix}.json`;
  const outputName = `verifier-agent-output${suffix}.log`;

  const bundle = {
    run_id: runId,
    turn: agentCtx.turn,
    requirement: requirementFromContract(agentCtx.contract),
    prior_reports: agentCtx.priorReports,
    previous_judgment: ctx.lastJudgment ?? null,
    evidence_refs: agentCtx.evidenceRefs,
    workspace_path: agentCtx.workspacePath,
  };
  await deps.runLedgerStore.writeArtifact(
    runId,
    inputName,
    `${JSON.stringify(bundle, null, 2)}\n`,
  );
  const inputRef = `artifact://${runId}/${inputName}`;

  let output = "";
  try {
    if (!ctx.input) {
      output = "verifier agent could not start: no assembled runtime input";
    } else {
      const adapterPolicy = resolveAdapterPolicy(ctx.input.adapterPolicy);
      const result = await deps.supervisor.startSession(
        ctx.input.cwd,
        {
          text: buildVerifierAgentPrompt({
            ...bundle,
            input_ref: inputRef,
          }),
          mode: "plan",
        },
        "plan",
        {
          permissions: ctx.input.permissions,
          env: ctx.input.env,
          providerName: loopRuntime(ctx.card)?.provider as
            | import("@yep-anywhere/shared").ProviderName
            | undefined,
          model: adapterPolicy.model ?? loopRuntime(ctx.card)?.model,
        },
      );
      if ("error" in result || "queued" in result) {
        output = "verifier agent could not start: supervisor queue unavailable";
      } else {
        const watched = await deps.watchProcess(runId, result as Process, {
          timeoutMs:
            adapterPolicy.timeoutMs ??
            (ctx.input.nativeInvocation.timeout_seconds
              ? ctx.input.nativeInvocation.timeout_seconds * 1000
              : undefined),
        });
        output =
          watched.finalText ||
          watched.error ||
          "(verifier agent produced no output)";
        if (!watched.ok && !watched.finalText) {
          // 進程異常且無輸出：直接 inconclusive, 不進 parse 碰運氣。
          await deps.runLedgerStore.writeArtifact(runId, outputName, output);
          return {
            verifier_phase: "review",
            status: "inconclusive",
            evidence_refs: [inputRef, `artifact://${runId}/${outputName}`],
            unresolved_risks: [
              `verifier agent did not complete successfully: ${output}`,
            ],
            recommendation: "escalate",
            confidence: 0.1,
            requires_human: false,
          };
        }
      }
    }
  } catch (error) {
    output =
      error instanceof Error
        ? error.message
        : `verifier agent failed: ${error}`;
  }

  await deps.runLedgerStore.writeArtifact(runId, outputName, output);
  return parseVerifierAgentOutput(output, {
    outputRef: `artifact://${runId}/${outputName}`,
    extraEvidenceRefs: [inputRef],
  });
}
