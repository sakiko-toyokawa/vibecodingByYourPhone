import type { IntentContract, VerifierReport } from "@yep-anywhere/shared";

/**
 * 可執行的驗證 phase（走 strategy.verify 與短路邏輯的段）。
 * review 由 run-service 的 collector/agent 提供真實報告 (verify-run 直接
 * append)。P0 起 rule / structural 加入可執行集合；interaction 現在由
 * InteractionAgentStrategy / runInteractionAgent 承載。
 */
export type ExecutableVerificationPhase =
  | "static"
  | "runtime"
  | "rule"
  | "structural"
  | "interaction";

/**
 * Verification strategy interface (contract-driven verification).
 *
 * Instead of assuming all workspaces are Node.js projects with test commands,
 * strategies verify based on the intent contract's success criteria and
 * workspace contents.
 */

export interface VerificationInput {
  contract: IntentContract;
  workspacePath: string;
  exitStatus: number;
  /** artifact name -> content (for file-based verification). */
  artifacts: Record<string, string>;
  turn: number;
  /**
   * The verifier-chain phase this call answers for. The orchestrator calls
   * the strategy once per phase; the report's verifier_phase must equal
   * this value (the orchestrator also overrides it defensively — 此前策略
   * 硬编码 "static", static/runtime 两段报告自相矛盾)。
   */
  phase: ExecutableVerificationPhase;
  /** Per-command timeout for subprocess-based strategies (verify-run input). */
  timeoutMs?: number;
  /**
   * Persist a command's output log and return its artifact ref (provided by
   * the orchestration layer / RunLedgerStore). Strategies that spawn
   * subprocesses must route their logs through this — 返回 "" 会让
   * evidence_refs 变成空字符串数组流进 judgment (教训: 证据不落盘 =
   * verifier theater)。
   */
  writeEvidence: (name: string, content: string) => Promise<string>;
}

export interface VerificationStrategy {
  /** Unique name of the strategy (for audit and debugging). */
  readonly name: string;
  /**
   * Verify the turn's outcome against the intent contract's success criteria.
   * Returns a verifier report with status, evidence, and recommendation.
   */
  verify(input: VerificationInput): Promise<VerifierReport>;
}
