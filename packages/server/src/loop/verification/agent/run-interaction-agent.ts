import type { VerifierReport } from "@yep-anywhere/shared";
import type { Process } from "../../../supervisor/Process.js";
import type { Supervisor } from "../../../supervisor/Supervisor.js";
import { resolveAdapterPolicy } from "../../assembly/adapter-policy.js";
import type { RunExecutionContext } from "../../run/types.js";
import { loopRuntime } from "../../run/workspace.js";
import type { RunLedgerStore } from "../../state/run-ledger-store.js";
import { InteractionAgentStrategy } from "../strategies/interaction/index.js";
import type { InteractionAgentContext } from "../verify-run.js";

export interface RunInteractionAgentDeps {
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

export async function runInteractionAgent(
  deps: RunInteractionAgentDeps,
  ctx: RunExecutionContext,
  agentCtx: InteractionAgentContext,
): Promise<VerifierReport> {
  const strategy = new InteractionAgentStrategy({
    config: ctx.card.loop.verification.interaction,
    generateScript: async (input, options) => {
      const suffix = input.turn === 1 ? "" : `-turn${input.turn}`;
      const prompt = buildInteractionPrompt(ctx, agentCtx, options.url);
      await deps.runLedgerStore.writeArtifact(
        agentCtx.runId,
        `interaction-agent-prompt${suffix}.md`,
        prompt,
      );

      if (!ctx.input) {
        return "interaction agent could not start: no assembled runtime input";
      }
      const adapterPolicy = resolveAdapterPolicy(ctx.input.adapterPolicy);
      const result = await deps.supervisor.startSession(
        ctx.input.cwd,
        { text: prompt, mode: "plan" },
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
        return "interaction agent could not start: supervisor queue unavailable";
      }

      const watched = await deps.watchProcess(agentCtx.runId, result as Process, {
        timeoutMs: Math.max(
          adapterPolicy.timeoutMs ??
            (ctx.input.nativeInvocation.timeout_seconds
              ? ctx.input.nativeInvocation.timeout_seconds * 1000
              : 0),
          ctx.card.loop.verification.interaction?.timeout_ms ?? 0,
        ) || undefined,
      });
      return (
        watched.finalText ||
        watched.error ||
        "(interaction agent produced no output)"
      );
    },
  });

  return strategy.verify({
    contract: agentCtx.contract,
    workspacePath: agentCtx.workspacePath,
    exitStatus: 0,
    artifacts: {},
    turn: agentCtx.turn,
    phase: "interaction",
    writeEvidence: async (name, content) => {
      await deps.runLedgerStore.writeArtifact(agentCtx.runId, name, content);
      return `artifact://${agentCtx.runId}/${name}`;
    },
  });
}

function buildInteractionPrompt(
  ctx: RunExecutionContext,
  agentCtx: InteractionAgentContext,
  url: string,
): string {
  return [
    "你是 Interaction Verifier Agent。你的任務是生成一個一次性的 Playwright ESM 驗證腳本。",
    "你不是最終裁判；系統會執行你生成的腳本，Playwright 執行結果才是 verdict。",
    "",
    "硬性要求：",
    "- 只輸出 JSON，不要輸出 Markdown。",
    "- JSON shape: { \"script\": string, \"rationale\": string, \"assumptions\": string[] }。",
    "- script 必須從 process.env.INTERACTION_URL 讀取 URL。",
    "- script 必須啟動 browser/page，執行至少一個與 success criteria 相關的 assertion。",
    "- assertion 失敗時讓腳本 throw，成功時正常 exit 0。",
    "- script 必須 close browser。",
    "- 不要修改 workspace 文件，不要執行 shell 命令。",
    "",
    `INTERACTION_URL: ${url}`,
    `Workspace: ${agentCtx.workspacePath}`,
    `Loop: ${ctx.card.loop.id}`,
    "",
    "IntentContract:",
    JSON.stringify(agentCtx.contract, null, 2),
    "",
    "Prior verifier reports:",
    JSON.stringify(agentCtx.priorReports, null, 2),
    "",
    "Evidence refs:",
    JSON.stringify(agentCtx.evidenceRefs, null, 2),
  ].join("\n");
}
