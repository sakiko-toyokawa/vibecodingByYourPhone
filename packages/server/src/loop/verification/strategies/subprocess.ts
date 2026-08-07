import type { VerifierReport } from "@yep-anywhere/shared";
import type { VerificationInput, VerificationStrategy } from "../strategy.js";
import { runVerificationCommands } from "../subprocess-verifier.js";

/**
 * Subprocess verification strategy (improved version of the current implementation).
 *
 * Runs the commands of the requested phase and checks exit codes and output.
 * Used when the workspace has test commands or custom commands are specified.
 * The orchestrator calls this once per phase — running BOTH phases' commands
 * per call would execute `pnpm test` twice per turn (教训: 此前 verify 无视
 * phase 参数跑全量)。
 */
export class SubprocessStrategy implements VerificationStrategy {
  readonly name = "subprocess";

  constructor(
    private commands: {
      static?: string[];
      runtime?: string[];
    },
  ) {}

  async verify(input: VerificationInput): Promise<VerifierReport> {
    // 收窄: 本策略只承載 static/runtime 兩段; rule/structural 由專屬策略
    // 承載, 走到這裡視為無命令 (空命令 = vacuous pass, 由 runVerificationCommands 處理)。
    const phase = input.phase === "runtime" ? "runtime" : "static";
    const commands = this.commands[phase] ?? [];
    return runVerificationCommands({
      phase,
      commands,
      cwd: input.workspacePath,
      timeoutMs: input.timeoutMs,
      writeEvidence: input.writeEvidence,
    });
  }
}
