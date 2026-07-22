/**
 * Phase-0 minimal assembly (spec: docs/spec/01-架构.md loop/assembly,
 * 05-分阶段计划.md 阶段 0 "最小装配").
 *
 * Projects a LoopCard + IntentContract into the native call parameters for
 * Supervisor.startSession: a read-only prompt, the working directory, and
 * the permission settings that keep the run read-only.
 *
 * Phase-0 exclusions (per 05): no memory packet, no policy projection.
 * Read-only enforcement here is two layers:
 *  1. permissionMode "plan" — read-only tools auto-approve, everything else
 *     asks, and the run service auto-denies every approval request
 *     (unattended run: asking would hang the turn);
 *  2. explicit deny rules for the file-mutating tools, so writes fail fast
 *     instead of round-tripping through an approval request.
 */

import type {
  IntentContract,
  LoopCard,
  PermissionRules,
} from "@yep-anywhere/shared";

export interface RuntimeInput {
  prompt: string;
  /** Absolute path of the target project (card.loop.workspace.path). */
  cwd: string;
  permissionMode: "plan";
  permissions: PermissionRules;
}

/** File-mutating tools denied outright in phase-0 read-only runs. */
const READ_ONLY_DENY: string[] = ["Edit", "Write", "NotebookEdit", "MultiEdit"];

export class AssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssemblyError";
  }
}

export function assembleRuntimeInput(
  card: LoopCard,
  contract: IntentContract,
): RuntimeInput {
  const loop = card.loop;
  const cwd = loop.workspace.path;
  if (!cwd) {
    throw new AssemblyError(
      `Loop '${loop.id}' has no workspace.path — a target project path is required to start a run`,
    );
  }

  const discovery = loop.discovery ?? {};
  const handoff = loop.handoff ?? {};
  const maxItems = handoff.max_items_per_run;

  const prompt = [
    "You are running as an unattended, READ-ONLY loop task (permission mode: plan).",
    "",
    "Hard rules (violations are auto-denied):",
    "- Only scan, read, and report. Do NOT create, modify, or delete any file. Do NOT run mutating commands.",
    "- Do NOT call ExitPlanMode or AskUserQuestion — every approval request is auto-denied; finish by writing the report as plain text.",
    "- Use only read-only tools (Read, Glob, Grep, etc.).",
    "",
    "Task:",
    `- Task type: ${contract.task_type.primary}`,
    `- Goal: ${contract.raw_goal}`,
    discovery.source ? `- Discovery source: ${discovery.source}` : null,
    discovery.query ? `- Discovery query: ${discovery.query}` : null,
    maxItems !== undefined ? `- Report at most ${maxItems} items.` : null,
    "",
    "Success criteria:",
    ...contract.success_criteria.map((c) => `- ${c}`),
    "",
    "Report format (plain text, in this order):",
    "1. Scope scanned",
    "2. Findings (itemized)",
    "3. Suggested follow-ups for human review",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return {
    prompt,
    cwd,
    permissionMode: "plan",
    permissions: { deny: [...READ_ONLY_DENY] },
  };
}
