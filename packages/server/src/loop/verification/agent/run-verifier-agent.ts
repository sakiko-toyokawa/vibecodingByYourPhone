import type { VerifierReport } from "@yep-anywhere/shared";
import type { Process } from "../../../supervisor/Process.js";
import type { Supervisor } from "../../../supervisor/Supervisor.js";
import { resolveAdapterPolicy } from "../../assembly/adapter-policy.js";
import type { RunExecutionContext } from "../../run/types.js";
import { loopRuntime } from "../../run/workspace.js";
import type { RunLedgerStore } from "../../state/run-ledger-store.js";
import type { ReviewAgentContext } from "../verify-run.js";
import {
  parseVerifierAgentOutput,
  parseVerifierAgentVerdict,
} from "./parse.js";
import {
  buildVerifierAgentPrompt,
  buildVerifierAgentRecoveryPrompt,
  requirementFromContract,
} from "./prompt.js";

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
 * - 輸出：先 repair / corrective retry 一次（parse.ts + recovery prompt）；
 *   agent 崩潰/逾時/無輸出或 retry 後仍無效 = inconclusive + escalate，
 *   絕不讓未驗證文本進賬本。
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
    usage?: { tokens: number } | null;
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
  const basePrompt = buildVerifierAgentPrompt({
    ...bundle,
    input_ref: inputRef,
  });

  const attempt = async (
    promptText: string,
    attemptOutputName: string,
  ): Promise<{ output: string; canRetry: boolean }> => {
    let output = "";
    let canRetry = false;
    try {
      if (!ctx.input) {
        output = "verifier agent could not start: no assembled runtime input";
      } else {
        const adapterPolicy = resolveAdapterPolicy(ctx.input.adapterPolicy);
        const result = await deps.supervisor.startSession(
          ctx.input.cwd,
          {
            text: promptText,
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
          output =
            "verifier agent could not start: supervisor queue unavailable";
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
          if (watched.usage) {
            const usageName = attemptOutputName
              .replace("verifier-agent-output", "verifier-agent-usage")
              .replace(/\.log$/, ".json");
            await deps.runLedgerStore.writeArtifact(
              runId,
              usageName,
              `${JSON.stringify({ tokens: watched.usage.tokens })}\n`,
            );
          }
          const transientError =
            typeof watched.error === "string" &&
            /reconnect|stale|no sdk messages|timeout|network|socket|econn|tls|api error/i.test(
              watched.error,
            );
          canRetry = Boolean(watched.ok || watched.finalText || transientError);
        }
      }
    } catch (error) {
      output =
        error instanceof Error
          ? error.message
          : `verifier agent failed: ${error}`;
    }
    await deps.runLedgerStore.writeArtifact(runId, attemptOutputName, output);
    return { output, canRetry };
  };

  const first = await attempt(basePrompt, outputName);
  const firstOutputRef = `artifact://${runId}/${outputName}`;
  const firstVerdict = parseVerifierAgentVerdict(first.output);
  if (firstVerdict.ok) {
    return parseVerifierAgentOutput(first.output, {
      outputRef: firstOutputRef,
      extraEvidenceRefs: [inputRef],
    });
  }

  if (!first.canRetry) {
    // 進程異常/佇列不可用時重試沒有意義，直接保留原始輸出供排查。
    return parseVerifierAgentOutput(first.output, {
      outputRef: firstOutputRef,
      extraEvidenceRefs: [inputRef],
    });
  }

  const retryOutputName = `verifier-agent-output${suffix}-retry1.log`;
  const retryOutputRef = `artifact://${runId}/${retryOutputName}`;
  const second = await attempt(
    buildVerifierAgentRecoveryPrompt({
      basePrompt,
      previousOutput: first.output,
      validationError: firstVerdict.error,
    }),
    retryOutputName,
  );
  const secondVerdict = parseVerifierAgentVerdict(second.output);
  if (secondVerdict.ok) {
    return parseVerifierAgentOutput(second.output, {
      outputRef: retryOutputRef,
      extraEvidenceRefs: [inputRef, firstOutputRef],
    });
  }

  const fallback = parseVerifierAgentOutput(second.output, {
    outputRef: retryOutputRef,
    extraEvidenceRefs: [inputRef, firstOutputRef],
  });
  fallback.unresolved_risks.unshift(
    `verifier JSON recovery retry failed (${firstVerdict.error}; retry error: ${secondVerdict.error})`,
  );
  return fallback;
}
