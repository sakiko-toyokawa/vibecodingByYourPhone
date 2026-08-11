import { existsSync } from "node:fs";
import path from "node:path";
import type { VerifierIssue } from "@yep-anywhere/shared";
import { runCommand } from "../../../subprocess-verifier.js";
import { findFiles } from "../files.js";
import type { StructuralPlugin, StructuralPluginOutcome } from "../plugin.js";

const PYRIGHT_DIAGNOSTIC_RE =
  /^(.+?):(\d+):(\d+)\s+-\s+(error|warning):\s+(.+)$/;

/**
 * Python structural checker using pyright diagnostics.
 *
 * pyright is intentionally the default because it is the practical Python
 * type checker used by this project's design. When pyright is not installed
 * the checker reports inconclusive instead of claiming the workspace passed.
 */
export class PythonChecker implements StructuralPlugin {
  readonly name = "python";

  constructor(private readonly pyrightCommand = "pyright") {}

  async run(input: {
    workspacePath: string;
    phase: VerifierIssue["layer"];
    timeoutMs?: number;
  }): Promise<StructuralPluginOutcome> {
    const pythonFiles = await findFiles(input.workspacePath, (file) =>
      file.endsWith(".py"),
    );
    const hasProjectMarkers = [
      "pyproject.toml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
    ].some((name) => existsSync(path.join(input.workspacePath, name)));
    if (pythonFiles.length === 0 && !hasProjectMarkers) {
      return { issues: [], risks: [], applicable: false };
    }

    const outcome = await runCommand(this.pyrightCommand, {
      cwd: input.workspacePath,
      timeoutMs: input.timeoutMs,
    });
    const rawLog = `$ ${this.pyrightCommand}\noutcome: ${outcome.kind}${
      outcome.exitCode !== null ? ` (exit ${outcome.exitCode})` : ""
    } in ${outcome.durationMs}ms\n\n${outcome.output}`;
    const issues: VerifierIssue[] = [];
    const risks: string[] = [];

    for (const line of outcome.output.split("\n")) {
      const match = line.trim().match(PYRIGHT_DIAGNOSTIC_RE);
      if (!match) continue;
      const [, file, lineNo, col, severity, message] = match;
      issues.push({
        id: `pyright@${file}:${lineNo}`,
        severity: severity === "error" ? "major" : "minor",
        layer: input.phase,
        location: {
          file: file ?? "",
          line: Number(lineNo),
          column: Number(col),
        },
        message: message ?? "",
      });
    }

    if (outcome.kind !== "exit") {
      return {
        issues,
        risks: [
          outcome.kind === "timeout"
            ? `pyright 逾時（${input.timeoutMs ?? "default"}ms）`
            : "pyright 在此 workspace 不可執行（spawn_failed）——無法取得 Python 型別診斷",
        ],
        applicable: true,
        inconclusive: true,
        rawLog,
      };
    }
    if (outcome.exitCode !== 0) {
      risks.push(
        issues.length > 0
          ? `pyright 報 ${issues.length} 個型別錯誤`
          : `pyright 退出碼 ${outcome.exitCode}（輸出無法解析為 diagnostics）`,
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
