import { existsSync } from "node:fs";
import path from "node:path";
import type { VerifierIssue } from "@yep-anywhere/shared";
import { runCommand } from "../../../subprocess-verifier.js";
import { findFiles } from "../files.js";
import type { StructuralPlugin, StructuralPluginOutcome } from "../plugin.js";

const CARGO_DIAGNOSTIC_RE =
  /^(.+?):(\d+):(\d+):\s+(error|warning)(?:\[([A-Za-z0-9_]+)\])?:\s+(.+)$/;

/**
 * Rust structural checker using cargo check short diagnostics.
 */
export class RustChecker implements StructuralPlugin {
  readonly name = "rust";

  constructor(
    private readonly cargoCommand = "cargo check --all-targets --message-format=short",
  ) {}

  async run(input: {
    workspacePath: string;
    phase: VerifierIssue["layer"];
    timeoutMs?: number;
  }): Promise<StructuralPluginOutcome> {
    const rustFiles = await findFiles(input.workspacePath, (file) =>
      file.endsWith(".rs"),
    );
    if (
      rustFiles.length === 0 &&
      !existsSync(path.join(input.workspacePath, "Cargo.toml"))
    ) {
      return { issues: [], risks: [], applicable: false };
    }

    const outcome = await runCommand(this.cargoCommand, {
      cwd: input.workspacePath,
      timeoutMs: input.timeoutMs,
    });
    const rawLog = `$ ${this.cargoCommand}\noutcome: ${outcome.kind}${
      outcome.exitCode !== null ? ` (exit ${outcome.exitCode})` : ""
    } in ${outcome.durationMs}ms\n\n${outcome.output}`;
    const issues: VerifierIssue[] = [];
    const risks: string[] = [];

    for (const line of outcome.output.split("\n")) {
      const match = line.trim().match(CARGO_DIAGNOSTIC_RE);
      if (!match) continue;
      const [, file, lineNo, col, severity, code, message] = match;
      issues.push({
        id: `${code ?? "cargo"}@${file}:${lineNo}`,
        severity: severity === "error" ? "major" : "minor",
        layer: input.phase,
        location: {
          file: file ?? "",
          line: Number(lineNo),
          column: Number(col),
        },
        message: `${code ? `${code}: ` : ""}${message ?? ""}`,
      });
    }

    if (outcome.kind !== "exit") {
      return {
        issues,
        risks: [
          outcome.kind === "timeout"
            ? `cargo check 逾時（${input.timeoutMs ?? "default"}ms）`
            : "cargo check 在此 workspace 不可執行（spawn_failed）——無法取得 Rust 結構診斷",
        ],
        applicable: true,
        inconclusive: true,
        rawLog,
      };
    }
    if (outcome.exitCode !== 0) {
      risks.push(
        issues.length > 0
          ? `cargo check 報 ${issues.length} 個錯誤`
          : `cargo check 退出碼 ${outcome.exitCode}（輸出無法解析為 diagnostics）`,
      );
    }
    return {
      issues,
      risks,
      applicable: true,
      inconclusive: false,
      rawLog,
    };
  }
}
