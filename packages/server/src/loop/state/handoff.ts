/**
 * Phase 6 dual-track handoff:
 * - `human-report.md`: AU2 八段式 human-readable report.
 * - `machine-state.json`: exact machine-readable recovery snapshot.
 */

import {
  type HumanHandoffReport,
  HumanHandoffReportSchema,
  type HumanHandoffTool,
  type MachineState,
  MachineStateSchema,
  type RunStateRecord,
  type WorkspaceSnapshot,
} from "@yep-anywhere/shared";
import { checksumOfJson, sha256Hex } from "../../utils/checksum.js";
import type { RunExecutionContext } from "../run/types.js";
import { hashLargeContent, redactForHumanReport } from "./redact.js";
import type { RunLedgerStore } from "./run-ledger-store.js";

export interface WriteDualTrackHandoffOptions {
  runStateRecord: RunStateRecord;
  checkpointEventId: string | null;
  workspaceSnapshot: WorkspaceSnapshot | null;
  toolUsage?: HumanHandoffTool[];
  executionError?: string | null;
}

export interface DualTrackHandoffDeps {
  runLedgerStore: RunLedgerStore;
}

export function renderHumanReport(report: HumanHandoffReport): string {
  const lines = [
    `# Loop Handoff: ${report.loop_id} / run ${report.run_id}`,
    "",
    `- **turn**: ${report.turn}`,
    `- **created_at**: ${report.created_at}`,
    "",
    "## 1. 背景上下文",
    "",
    report.sections.background_context,
    "",
    "## 2. 關鍵決策",
    "",
  ];

  if (report.sections.key_decisions.length === 0) {
    lines.push("(none)", "");
  } else {
    for (const item of report.sections.key_decisions) {
      lines.push(
        `- **${item.decision}**: ${item.rationale}${item.evidence_ref ? ` (${item.evidence_ref})` : ""}`,
      );
    }
    lines.push("");
  }

  lines.push("## 3. 工具使用記錄", "");
  if (report.sections.tool_usage.length === 0) {
    lines.push("(none)", "");
  } else {
    for (const item of report.sections.tool_usage) {
      lines.push(
        `- **${item.tool}**: ${item.purpose}${item.result_ref ? ` (${item.result_ref})` : ""}`,
      );
    }
    lines.push("");
  }

  lines.push("## 4. 用戶意圖演進", "");
  if (report.sections.user_intent_evolution.length === 0) {
    lines.push("(none)", "");
  } else {
    for (const item of report.sections.user_intent_evolution) {
      lines.push(
        `- **${item.stage}**: ${item.intent}${item.reason ? ` (${item.reason})` : ""}`,
      );
    }
    lines.push("");
  }

  lines.push("## 5. 執行結果匯總", "");
  if (report.sections.execution_results.length === 0) {
    lines.push("(none)", "");
  } else {
    for (const item of report.sections.execution_results) {
      lines.push(
        `- **turn ${item.turn} / ${item.status}**: ${item.summary}${item.refs.length > 0 ? ` (${item.refs.join(", ")})` : ""}`,
      );
    }
    lines.push("");
  }

  lines.push("## 6. 錯誤與解決", "");
  if (report.sections.errors_and_solutions.length === 0) {
    lines.push("(none)", "");
  } else {
    for (const item of report.sections.errors_and_solutions) {
      lines.push(`- **${item.error}**: ${item.solution} (${item.status})`);
    }
    lines.push("");
  }

  lines.push("## 7. 未解決問題", "");
  if (report.sections.unresolved_questions.length === 0) {
    lines.push("(none)", "");
  } else {
    for (const item of report.sections.unresolved_questions) {
      lines.push(
        `- [${item.priority}] ${item.question}${item.owner ? ` (owner: ${item.owner})` : ""}`,
      );
    }
    lines.push("");
  }

  lines.push("## 8. 後續計劃", "");
  if (report.sections.next_plan.length === 0) {
    lines.push("(none)", "");
  } else {
    for (const item of report.sections.next_plan) {
      lines.push(
        `- **${item.action}**${item.owner ? ` (owner: ${item.owner})` : ""}${item.depends_on ? ` (depends_on: ${item.depends_on})` : ""}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function writeDualTrackHandoff(
  deps: DualTrackHandoffDeps,
  ctx: RunExecutionContext,
  options: WriteDualTrackHandoffOptions,
): Promise<{ humanReportRef: string; machineStateRef: string }> {
  const { runId, loopId } = ctx.active;
  const workspacePath =
    ctx.workspaceEvidence?.originPath ?? ctx.card.loop.workspace.path ?? "";
  const contractText =
    ctx.contract?.raw_goal ??
    ctx.card.loop.handoff?.task ??
    "(no intent captured)";
  const report = HumanHandoffReportSchema.parse({
    schema_version: 2,
    run_id: runId,
    loop_id: loopId,
    turn: ctx.turn,
    created_at: new Date().toISOString(),
    sections: {
      background_context: redactForHumanReport(
        [
          `Loop: ${loopId}`,
          `Task: ${contractText}`,
          ctx.workspaceEvidence
            ? "Workspace strategy: worktree (origin {workspace})"
            : "Workspace strategy: direct",
        ].join("\n"),
        workspacePath,
      ),
      key_decisions:
        ctx.lastJudgment === null
          ? []
          : [
              {
                decision: ctx.lastJudgment.next_action,
                rationale: redactForHumanReport(
                  `overall=${ctx.lastJudgment.overall}; retryable=${ctx.lastJudgment.retryable}; requires_human=${ctx.lastJudgment.requires_human}`,
                  workspacePath,
                ),
                evidence_ref: ctx.lastJudgmentRef ?? undefined,
              },
            ],
      tool_usage: (options.toolUsage ?? []).map((item) => ({
        ...item,
        idempotency_key:
          item.idempotency_key ??
          sha256Hex(`${runId}:${ctx.turn}:${item.tool}:${item.purpose}`),
        expected_hash:
          item.expected_hash ??
          (item.purpose ? sha256Hex(item.purpose) : undefined),
      })),
      user_intent_evolution: [
        {
          stage: `turn ${ctx.turn}`,
          intent: redactForHumanReport(contractText, workspacePath),
          reason: ctx.contract?.intent_understanding?.understanding_summary
            ? redactForHumanReport(
                ctx.contract.intent_understanding.understanding_summary,
                workspacePath,
              )
            : undefined,
        },
      ],
      execution_results: [
        {
          turn: ctx.turn,
          status: options.runStateRecord.state,
          summary: hashLargeContent(
            redactForHumanReport(
              options.executionError ??
                `turn completed with state ${options.runStateRecord.state}`,
              workspacePath,
            ),
          ),
          refs: [
            ...(ctx.lastJudgmentRef ? [ctx.lastJudgmentRef] : []),
            ...(options.runStateRecord.last_judgment &&
            options.runStateRecord.last_judgment !== ctx.lastJudgmentRef
              ? [options.runStateRecord.last_judgment]
              : []),
            ...(ctx.lastJudgment?.evidence ?? []),
          ],
        },
      ],
      errors_and_solutions: options.executionError
        ? [
            {
              error: redactForHumanReport(
                options.executionError,
                workspacePath,
              ),
              solution: "see judgment evidence and next plan",
              status: "needs_review",
            },
          ]
        : [],
      unresolved_questions: (ctx.lastJudgment?.unresolved_risks ?? []).map(
        (risk) => ({
          question: redactForHumanReport(risk, workspacePath),
          priority: "high" as const,
          owner: "human",
        }),
      ),
      next_plan: buildNextPlan(ctx, options.runStateRecord),
    },
  });
  const humanReport = renderHumanReport(report);
  await deps.runLedgerStore.writeArtifact(
    runId,
    "human-report.md",
    humanReport,
  );

  const machinePayload = {
    schema_version: 2,
    run_id: runId,
    loop_id: loopId,
    turn: ctx.turn,
    record: options.runStateRecord,
    checkpoint_event_id: options.checkpointEventId,
    artifact_manifest_ref: `artifact://${runId}/manifest.jsonl`,
    workspace_snapshot: options.workspaceSnapshot,
    working_state_ref: ctx.workingState
      ? `artifact://${runId}/working-state.json`
      : null,
    created_at: new Date().toISOString(),
  };
  const machineState = MachineStateSchema.parse({
    ...machinePayload,
    checksum: checksumOfJson(machinePayload),
  });
  await deps.runLedgerStore.writeArtifact(
    runId,
    "machine-state.json",
    `${JSON.stringify(machineState, null, 2)}\n`,
  );

  return {
    humanReportRef: `artifact://${runId}/human-report.md`,
    machineStateRef: `artifact://${runId}/machine-state.json`,
  };
}

function buildNextPlan(
  ctx: RunExecutionContext,
  record: RunStateRecord,
): HumanHandoffReport["sections"]["next_plan"] {
  switch (record.state) {
    case "complete":
      return [{ action: "close run; no further automated turn" }];
    case "failed":
      return [
        {
          action: "review failure evidence",
          owner: "human",
          depends_on: `artifact://${ctx.active.runId}/machine-state.json`,
        },
      ];
    case "needs_human":
    case "paused":
    case "budget_limited":
      return [
        {
          action: `await human decision for ${record.state}`,
          owner: "human",
        },
      ];
    default:
      return [
        {
          action: `continue from turn ${record.turn + 1}`,
          depends_on: ctx.pendingContext ? "inject pending context" : undefined,
        },
      ];
  }
}

export type { MachineState };
