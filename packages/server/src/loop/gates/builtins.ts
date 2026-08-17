import type { LoopCard } from "@yep-anywhere/shared";
import type { LoopProposalLifecycleService } from "../proposal/lifecycle-service.js";
import { loopProposalPromptLines } from "../proposal/loop-proposal.js";
import type { RelationLifecycleService } from "../relation/lifecycle-service.js";
import {
  type GateContext,
  type GateDefinition,
  GateRegistry,
} from "./registry.js";

function relationGate(
  kind: "pr_publish" | "issue_proposal",
  lifecycle: RelationLifecycleService,
): GateDefinition {
  return {
    kind,
    exclusiveGroup: "github-publish",
    enabledFor: (card) => card.loop.discovery?.source === "github_prompt",
    onRunCompleted: async (ctx, finalText) => {
      // 维护回合（带着既有 relation 的 run）不注册新的发布提案。
      if (ctx.hasRelation) {
        return false;
      }
      const method =
        kind === "pr_publish"
          ? lifecycle.registerGithubPrPublish.bind(lifecycle)
          : lifecycle.registerGithubIssueProposal.bind(lifecycle);
      return Boolean(await method(ctx.loopId, ctx.runId, finalText));
    },
  };
}

export function createBuiltinGateRegistry(
  relationLifecycle: RelationLifecycleService,
  loopProposalLifecycle?: LoopProposalLifecycleService,
): GateRegistry {
  const registry = new GateRegistry();
  registry.register(relationGate("pr_publish", relationLifecycle));
  registry.register(relationGate("issue_proposal", relationLifecycle));
  if (loopProposalLifecycle) {
    registry.register({
      kind: "loop_proposal",
      enabledFor: (card: LoopCard) => card.loop.can_propose_loops === true,
      // 完整标记语法 + JSON 示例，与兜底路径共用同一事实来源；
      // 阉割成泛泛描述会让 agent 产不出可解析的提案块。
      promptLines: loopProposalPromptLines,
      onRunCompleted: async (ctx: GateContext, finalText: string) => {
        await loopProposalLifecycle.registerLoopProposal(
          ctx.loopId,
          ctx.runId,
          finalText,
        );
        return false;
      },
    });
  }
  return registry;
}
