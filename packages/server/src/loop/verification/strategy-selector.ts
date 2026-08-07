import type { LoopCard } from "@yep-anywhere/shared";
import type { IntentContract } from "@yep-anywhere/shared";
import {
  detectCommandsForProjectType,
  detectProjectType,
} from "./project-type.js";
import { ContractCriteriaStrategy } from "./strategies/contract-criteria.js";
import { FileContentStrategy } from "./strategies/file-content.js";
import { FileExistenceStrategy } from "./strategies/file-existence.js";
import { InteractionAgentStrategy } from "./strategies/interaction/index.js";
import { RuleBasedStrategy } from "./strategies/rule-based.js";
import { StructuralStrategy } from "./strategies/structural/index.js";
import { SubprocessStrategy } from "./strategies/subprocess.js";
import type {
  ExecutableVerificationPhase,
  VerificationStrategy,
} from "./strategy.js";

/**
 * Strategy selector for verification.
 *
 * Chooses the most appropriate verification strategy based on the loop card,
 * intent contract, and workspace contents.
 *
 * P0: rule / structural 是 schema 與短路管線的掛載點。
 * P2: rule phase 由 RuleBasedStrategy 承載（card 內嵌 rules +
 * workspace `.verifier/rules.json` 合併執行；無規則時策略內回
 * inconclusive + escalate，不靜默通過）。
 * P3: structural phase 由 StructuralStrategy 承載（TypeScript
 * diagnostics + 循環依賴 + JSON Schema 配對驗證；無適用 checker 時
 * inconclusive + escalate）。PhaseNotImplementedStrategy 目前無消費者，
 * 保留作為未來新 phase 的兜底模板。
 */
export async function selectVerificationStrategy(
  card: LoopCard,
  contract: IntentContract,
  workspacePath: string,
  phase: ExecutableVerificationPhase = "static",
): Promise<VerificationStrategy> {
  if (phase === "rule") {
    return new RuleBasedStrategy(card.loop.verification.rules ?? []);
  }
  if (phase === "structural") {
    return new StructuralStrategy();
  }
  if (phase === "interaction") {
    return new InteractionAgentStrategy({
      config: card.loop.verification.interaction,
    });
  }

  const customCommands = card.loop.verification.commands;

  // 1. Card 顯式釘死的檢查優先 (P1): 命令 > file_contains > file_exists,
  // 都排在自動探測之前 —— card 明確配置即為該 loop 的驗證意圖。
  if (customCommands?.static || customCommands?.runtime) {
    return new SubprocessStrategy({
      static: customCommands.static,
      runtime: customCommands.runtime,
    });
  }
  if (
    customCommands?.file_contains &&
    customCommands.file_contains.length > 0
  ) {
    return new FileContentStrategy(customCommands.file_contains);
  }
  if (customCommands?.file_exists && customCommands.file_exists.length > 0) {
    return new FileExistenceStrategy(customCommands.file_exists);
  }

  // 2. Detect project type and use appropriate commands
  const projectType = await detectProjectType(workspacePath);
  if (projectType !== "unknown") {
    const commands = await detectCommandsForProjectType(
      projectType,
      workspacePath,
    );
    if (commands.static.length > 0 || commands.runtime.length > 0) {
      return new SubprocessStrategy(commands);
    }
  }

  // 3. If intent contract has success criteria, use ContractCriteriaStrategy
  if (contract.success_criteria.length > 0) {
    return new ContractCriteriaStrategy(contract.success_criteria);
  }

  // 4. Default to FileExistenceStrategy (check basic files exist)
  return new FileExistenceStrategy([]);
}
