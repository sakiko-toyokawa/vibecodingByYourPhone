/**
 * Deterministic subprocess verifier (spec: docs/spec/05-分阶段计划.md 阶段 1
 * "确定性子进程，退出码 + 结构化输出即 verifier_report").
 *
 * Runs one shell command per verification step in the target workspace with
 * a mandatory timeout (default 120s, configurable) and maps the outcome to a
 * verifier_report:
 *   - exit 0                → passed
 *   - exit non-zero         → failed
 *   - timeout / not runnable → inconclusive
 *
 * Commands run through the platform shell (`exec`) so package-manager
 * shims like `pnpm` resolve on every OS. A shell-level "command not found"
 * (exit 127 on sh, "not recognized" on cmd) is classified as not-runnable
 * (spawn_failed → inconclusive), since the shell itself always starts.
 */

import { exec } from "node:child_process";
import type { VerifierReport, VerifierStatus } from "@yep-anywhere/shared";

export const DEFAULT_VERIFIER_TIMEOUT_MS = 120_000;

/** Combined stdout+stderr kept per command log; tails beyond this are cut. */
const OUTPUT_CAP_BYTES = 256 * 1024;

export type SubprocessOutcomeKind = "exit" | "timeout" | "spawn_failed";

export interface SubprocessOutcome {
  kind: SubprocessOutcomeKind;
  /** null unless kind === "exit" */
  exitCode: number | null;
  /** combined stdout+stderr (capped) */
  output: string;
  durationMs: number;
}

export interface RunCommandOptions {
  cwd: string;
  timeoutMs?: number;
}

const NOT_RECOGNIZED = /command not found|is not recognized|not found/i;

export function runCommand(
  command: string,
  options: RunCommandOptions,
): Promise<SubprocessOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFIER_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd: options.cwd,
        timeout: timeoutMs,
        killSignal: "SIGTERM",
        maxBuffer: OUTPUT_CAP_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        const output = `${stdout}${stderr}`.slice(0, OUTPUT_CAP_BYTES);

        if (!error) {
          resolve({ kind: "exit", exitCode: 0, output, durationMs });
          return;
        }
        // exec timeout: process killed after exceeding `timeout`
        if (error.killed || error.signal === "SIGTERM") {
          resolve({ kind: "timeout", exitCode: null, output, durationMs });
          return;
        }
        const exitCode = typeof error.code === "number" ? error.code : null;
        // Shell could not find the executable (127 on sh, "not recognized"
        // on cmd) — the command is not runnable in this workspace.
        if (exitCode === 127 || NOT_RECOGNIZED.test(output)) {
          resolve({ kind: "spawn_failed", exitCode, output, durationMs });
          return;
        }
        resolve({ kind: "exit", exitCode, output, durationMs });
      },
    );
  });
}

export interface RunVerificationCommandsOptions extends RunCommandOptions {
  phase: "static" | "runtime";
  commands: string[];
  /**
   * Persist a command's output log and return its artifact ref; provided by
   * the orchestration layer (RunLedgerStore). Receives names already unique
   * per command (`verifier-output-<phase>-<n>.log`).
   */
  writeEvidence: (name: string, content: string) => Promise<string>;
}

/**
 * Run every command for one phase and fold the outcomes into a single
 * verifier_report. Worst status wins across commands (failed > inconclusive
 * > passed), mirroring the cross-report aggregation rule in 02 §6.
 */
export async function runVerificationCommands(
  options: RunVerificationCommandsOptions,
): Promise<VerifierReport> {
  const { phase, commands, writeEvidence } = options;

  if (commands.length === 0) {
    return {
      verifier_phase: phase,
      status: "inconclusive",
      evidence_refs: [],
      unresolved_risks: [
        `no ${phase} verification command configured or detected in the workspace`,
      ],
      recommendation: "escalate",
      confidence: 0.5,
      requires_human: false,
    };
  }

  let worst: VerifierStatus = "passed";
  const evidenceRefs: string[] = [];
  const unresolvedRisks: string[] = [];

  for (const [index, command] of commands.entries()) {
    const outcome = await runCommand(command, options);
    const log = [
      `$ ${command}`,
      `cwd: ${options.cwd}`,
      `outcome: ${outcome.kind}${
        outcome.exitCode !== null ? ` (exit ${outcome.exitCode})` : ""
      } in ${outcome.durationMs}ms`,
      "",
      outcome.output,
    ].join("\n");
    evidenceRefs.push(
      await writeEvidence(`verifier-output-${phase}-${index}.log`, log),
    );

    if (outcome.kind === "exit" && outcome.exitCode === 0) {
      continue;
    }
    if (outcome.kind === "exit") {
      worst = "failed";
      unresolvedRisks.push(`'${command}' exited with code ${outcome.exitCode}`);
    } else {
      if (worst !== "failed") {
        worst = "inconclusive";
      }
      unresolvedRisks.push(
        outcome.kind === "timeout"
          ? `'${command}' timed out after ${
              options.timeoutMs ?? DEFAULT_VERIFIER_TIMEOUT_MS
            }ms`
          : `'${command}' could not be executed in this workspace`,
      );
    }
  }

  return {
    verifier_phase: phase,
    status: worst,
    evidence_refs: evidenceRefs,
    unresolved_risks: unresolvedRisks,
    // passed → nothing left to do; failed → worth an automatic retry;
    // inconclusive → escalate (cannot be judged deterministically)
    recommendation:
      worst === "passed" ? "stop" : worst === "failed" ? "retry" : "escalate",
    confidence: worst === "passed" ? 0.95 : worst === "failed" ? 0.9 : 0.5,
    requires_human: false,
  };
}
