/**
 * Phase-1 verification orchestration (spec: docs/spec/05-分阶段计划.md 阶段 1
 * "两段起步" + 02-schema契约.md §5/§6).
 *
 * After one run's execution finishes, this walks the card's required
 * verifier chain:
 *   - static / runtime → deterministic subprocess commands (card-pinned
 *     commands first, workspace package.json probing otherwise)
 *   - interaction → marked not_applicable (phase 1 does not implement it;
 *     a placeholder artifact is written and it is excluded from aggregation)
 *   - review → not implemented in phase 1, same placeholder treatment
 *
 * Artifacts written under artifacts/<run_id>/ (refs returned for the ledger
 * entry's verification_refs):
 *   - verification-input.json      (VerificationInputBundle, 02 §5)
 *   - verifier-output-<phase>-<n>.log  (per-command output, evidence)
 *   - verifier-report-<phase>.json (per executed/placeholder phase)
 *   - verifier-reports.json        (all reports, the ledger's single ref)
 *   - judgment-report.json         (aggregated, 02 §6)
 */

import type {
  IntentContract,
  JudgmentReport,
  LoopCard,
  VerificationInputBundle,
  VerifierReport,
} from "@yep-anywhere/shared";
import {
  JudgmentReportSchema,
  VerificationInputBundleSchema,
  VerifierReportSchema,
} from "@yep-anywhere/shared";
import type { RunLedgerStore } from "../state/run-ledger-store.js";
import { aggregateVerifierReports } from "./aggregate.js";
import { selectRuntimeCommands } from "./runtime-verifier.js";
import { selectStaticCommands } from "./static-verifier.js";
import { runVerificationCommands } from "./subprocess-verifier.js";

export interface VerifyRunInput {
  card: LoopCard;
  contract: IntentContract;
  runId: string;
  /** Absolute workspace path (card.loop.workspace.path). */
  workspacePath: string;
  /** Executor exit status: 0 when the run's turn succeeded. */
  exitStatus: number;
  /** artifact:// ref of the executor stdout log, when written. */
  stdoutRef: string | null;
  /** Per-command timeout; defaults to 120s (subprocess-verifier). */
  timeoutMs?: number;
}

export interface VerificationRefs {
  verification_input: string;
  verifier_runtime: string;
  verifier_report: string;
  judgment_report: string;
}

export interface VerifyRunResult {
  reports: VerifierReport[];
  judgment: JudgmentReport;
  refs: VerificationRefs;
}

/** Phases without a phase-1 implementation get a not_applicable placeholder. */
const PLACEHOLDER_PHASES = new Set(["interaction", "review"]);

export async function verifyRun(
  input: VerifyRunInput,
  deps: { store: RunLedgerStore },
): Promise<VerifyRunResult> {
  const { card, contract, runId, workspacePath } = input;
  const { store } = deps;
  const required = card.loop.verification.required;

  const writeEvidence = async (name: string, content: string) => {
    await store.writeArtifact(runId, name, content);
    return `artifact://${runId}/${name}`;
  };

  const reports: VerifierReport[] = [];
  const executedPhases: string[] = [];

  for (const phase of required) {
    if (phase === "static" || phase === "runtime") {
      const commands =
        phase === "static"
          ? await selectStaticCommands(card, workspacePath)
          : await selectRuntimeCommands(card, workspacePath);
      const report = await runVerificationCommands({
        phase,
        commands,
        cwd: workspacePath,
        timeoutMs: input.timeoutMs,
        writeEvidence,
      });
      reports.push(VerifierReportSchema.parse(report));
      executedPhases.push(phase);
      await store.writeArtifact(
        runId,
        `verifier-report-${phase}.json`,
        `${JSON.stringify(report, null, 2)}\n`,
      );
      continue;
    }

    if (PLACEHOLDER_PHASES.has(phase)) {
      // 阶段 1 不做 interaction / review 段：写 not_applicable 占位，
      // 不参与聚合（不是 verifier_report，无 status 结论）。
      await store.writeArtifact(
        runId,
        `verifier-report-${phase}.json`,
        `${JSON.stringify(
          {
            verifier_phase: phase,
            status: "not_applicable",
            note: `phase '${phase}' is not implemented in loop phase 1; excluded from aggregation`,
          },
          null,
          2,
        )}\n`,
      );
    }
  }

  // 聚合策略（02 §6 policy）：阶段 1 无 budget 强制（阶段 2 接管），
  // allow_retry 由 verifier 的 retry 建议推导——failed 且存在 retry
  // recommendation 时 retryable 才为 true。
  const judgment = JudgmentReportSchema.parse(
    aggregateVerifierReports(reports, {
      allowRetry: reports.some((r) => r.recommendation === "retry"),
      budgetExhausted: false,
    }),
  );

  const bundle: VerificationInputBundle = VerificationInputBundleSchema.parse({
    intent_ref: `intent://${card.loop.id}`,
    task_type: contract.task_type.primary,
    success_criteria: contract.success_criteria,
    workspace_ref: `workspace://${card.loop.id}/${runId}`,
    exit_status: input.exitStatus,
    evidence_refs: {
      diff: null, // phase 1: no diff capture yet
      test_output: null,
      stdout: input.stdoutRef,
      stderr: null,
      structured_output: null,
      executor_summary: null,
    },
    runtime_event_refs: [],
    permission_event_refs: [],
    test_output_refs: reports
      .filter((r) => r.verifier_phase === "runtime")
      .flatMap((r) => r.evidence_refs),
    artifact_refs: [],
    // 阶段 1 无 policy projection（05：权限仍走 canUseTool 硬编码规则）——
    // 显式哨兵而非假引用，与 run-service 既有的 not_applicable 约定一致。
    policy_intent_ref: "not_applicable",
    known_failure_patterns: [],
    verifier_chain: required,
  });

  await store.writeArtifact(
    runId,
    "verification-input.json",
    `${JSON.stringify(bundle, null, 2)}\n`,
  );
  await store.writeArtifact(
    runId,
    "verifier-reports.json",
    `${JSON.stringify(reports, null, 2)}\n`,
  );
  await store.writeArtifact(
    runId,
    "judgment-report.json",
    `${JSON.stringify(judgment, null, 2)}\n`,
  );

  return {
    reports,
    judgment,
    refs: {
      verification_input: `artifact://${runId}/verification-input.json`,
      verifier_runtime: `verifier-runtime://subprocess:${
        executedPhases.join("+") || "none"
      }`,
      // 账本 schema 是单 ref；多份报告落在 verifier-reports.json 汇总文件
      verifier_report: `artifact://${runId}/verifier-reports.json`,
      judgment_report: `artifact://${runId}/judgment-report.json`,
    },
  };
}
