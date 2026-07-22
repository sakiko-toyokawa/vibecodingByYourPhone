/**
 * Workspace command probing for the two phase-1 verification segments.
 *
 * Used only when the LoopCard does not pin explicit commands
 * (`loop.verification.commands`). Mapping (05-分阶段计划.md 阶段 1):
 * lint / typecheck scripts → static, test script → runtime. A workspace
 * without the matching scripts yields no commands, and the verifier reports
 * inconclusive rather than guessing.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

const STATIC_SCRIPTS = ["lint", "typecheck"] as const;
const RUNTIME_SCRIPTS = ["test"] as const;

async function detectScripts(
  workspacePath: string,
  names: readonly string[],
): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(workspacePath, "package.json"), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unparseable package.json: probe finds nothing, verifier reports
    // inconclusive with the risk recorded — never crash the run.
    return [];
  }

  const scripts =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { scripts?: Record<string, unknown> }).scripts
      : undefined;
  if (!scripts) {
    return [];
  }
  return names
    .filter((name) => typeof scripts[name] === "string")
    .map((name) => `pnpm run ${name}`);
}

/** lint / typecheck scripts → static segment. */
export function detectStaticCommands(workspacePath: string): Promise<string[]> {
  return detectScripts(workspacePath, STATIC_SCRIPTS);
}

/** test script → runtime segment. */
export function detectRuntimeCommands(
  workspacePath: string,
): Promise<string[]> {
  return detectScripts(workspacePath, RUNTIME_SCRIPTS);
}
