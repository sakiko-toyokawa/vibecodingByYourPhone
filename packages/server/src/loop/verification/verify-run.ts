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
 * entry's verification_refs); turn > 1 files carry a `-turn<N>` suffix so a
 * retry never overwrites the previous turn's evidence:
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
  /** Current turn number; verification artifacts are named per-turn so a
   * retry turn does not overwrite the previous turn's evidence (02 §8.1:
   * 每次 retry 独立 entry + 保存引用). Turn 1 keeps the canonical names. */
  turn?: number;
  /** Absolute workspace path (card.loop.workspace.path). */
  workspacePath: string;
  /** Executor exit status: 0 when the run's turn succeeded. */
  exitStatus: number;
  /** artifact:// ref of the executor stdout log, when written. */
  stdoutRef: string | null;
  /** artifact:// ref of the turn's diff capture (diff.patch); null when the
   * workspace is not a git repo or the turn produced no changes. */
  diffRef?: string | null;
  /** artifact:// ref of the turn's normalized runtime event stream
   * (runtime-events jsonl); null when no events were captured. */
  runtimeEventsRef?: string | null;
  /** artifact:// ref of the executor's structured self-summary
   * (executor-summary markdown, extracted from the final report); null
   * when the executor did not produce the marked block. */
  executorSummaryRef?: string | null;
  /** artifact:// refs of the turn's permission events (policy hook verdicts);
   * 02 §5: 高风险任务必须包含。 */
  permissionEventRefs?: string[];
  /** 策略意图引用（02 §5 policy_intent_ref）：策略投影 run 传
   *  policy-projection.json 的 artifact:// 引用；无策略投影时缺省，
   *  落显式哨兵 "not_applicable"。 */
  policyIntentRef?: string | null;
  /** 已知失败模式 id（失败模式账本 open 模式），供 verifier 对照。 */
  knownFailurePatterns?: string[];
  /** review 段的真实报告（run-service 的 collector session 产出，修复计
   *  划 #12）：card 的 verifier_chain 含 review 时传入，参与聚合
   *  （requires_human 透传不再被丢弃）；缺省时 review 段保持
   *  not_applicable 占位。 */
  reviewReport?: VerifierReport;
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

/**
 * Per-turn verification artifact naming: turn 1 keeps the canonical base
 * name (phase-0/1 compatibility), later turns get a `-turn<N>` suffix so a
 * retry never overwrites the previous turn's evidence — the ledger entries
 * of earlier turns keep dereferenceable refs (02 §8.1).
 */
export function verificationArtifactName(base: string, turn: number): string {
  if (turn <= 1) {
    return base;
  }
  return base.replace(/\.json$/, `-turn${turn}.json`);
}

export async function verifyRun(
  input: VerifyRunInput,
  deps: { store: RunLedgerStore },
): Promise<VerifyRunResult> {
  const { card, contract, runId, workspacePath } = input;
  const { store } = deps;
  const required = card.loop.verification.required;
  const turn = input.turn ?? 1;

  const writeEvidence = async (name: string, content: string) => {
    await store.writeArtifact(runId, name, content);
    return `artifact://${runId}/${name}`;
  };

  const reports: VerifierReport[] = [];
  const executedPhases: string[] = [];
  // 短路规则 (四段验证模型.md: "低层硬失败且高层不会增加信息时, 直接
  // 停止升级"): 某段硬失败后, 后续段的结果不会改变聚合结论 (overall
  // 已锁定 failed, retryable 已存在) —— 跳过的段写 not_applicable 并
  // 注明短路原因, 不再空跑。
  let shortCircuitedBy: string | null = null;

  for (const phase of required) {
    if (shortCircuitedBy) {
      await store.writeArtifact(
        runId,
        verificationArtifactName(`verifier-report-${phase}.json`, turn),
        `${JSON.stringify(
          {
            verifier_phase: phase,
            status: "not_applicable",
            note: `short-circuited: phase '${shortCircuitedBy}' hard-failed and this phase cannot change the aggregate outcome (四段验证模型.md 短路规则)`,
          },
          null,
          2,
        )}\n`,
      );
      continue;
    }

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
        verificationArtifactName(`verifier-report-${phase}.json`, turn),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      if (report.status === "failed") {
        shortCircuitedBy = phase;
      }
      continue;
    }

    if (PLACEHOLDER_PHASES.has(phase)) {
      // review 段有真实报告 (collector session) 时不写占位 —— 由聚合前
      // 统一 append。
      if (phase === "review" && input.reviewReport) {
        continue;
      }
      // 阶段 1 不做 interaction / review 段：写 not_applicable 占位，
      // 不参与聚合（不是 verifier_report，无 status 结论）。
      await store.writeArtifact(
        runId,
        verificationArtifactName(`verifier-report-${phase}.json`, turn),
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

  // review 段真实报告 (collector session, 修复计划 #12): 落 per-phase
  // artifact 并参与聚合, requires_human 透传按 02 §6 最高优先生效。
  if (input.reviewReport) {
    const reviewReport = VerifierReportSchema.parse(input.reviewReport);
    reports.push(reviewReport);
    executedPhases.push("review");
    await store.writeArtifact(
      runId,
      verificationArtifactName("verifier-report-review.json", turn),
      `${JSON.stringify(reviewReport, null, 2)}\n`,
    );
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
      diff: input.diffRef ?? null,
      test_output: null,
      stdout: input.stdoutRef,
      stderr: null,
      structured_output: input.runtimeEventsRef ?? null,
      executor_summary: input.executorSummaryRef ?? null,
    },
    runtime_event_refs: input.runtimeEventsRef ? [input.runtimeEventsRef] : [],
    permission_event_refs: input.permissionEventRefs ?? [],
    test_output_refs: reports
      .filter((r) => r.verifier_phase === "runtime")
      .flatMap((r) => r.evidence_refs),
    artifact_refs: [],
    // 策略投影 run 引用 turn 1 落盘的 policy-projection.json；无策略投影
    // 的 run 落显式哨兵而非假引用（与 not_applicable 约定一致）。
    policy_intent_ref: input.policyIntentRef ?? "not_applicable",
    known_failure_patterns: input.knownFailurePatterns ?? [],
    verifier_chain: required,
  });

  const inputName = verificationArtifactName("verification-input.json", turn);
  const reportsName = verificationArtifactName("verifier-reports.json", turn);
  const judgmentName = verificationArtifactName("judgment-report.json", turn);
  await store.writeArtifact(
    runId,
    inputName,
    `${JSON.stringify(bundle, null, 2)}\n`,
  );
  await store.writeArtifact(
    runId,
    reportsName,
    `${JSON.stringify(reports, null, 2)}\n`,
  );
  await store.writeArtifact(
    runId,
    judgmentName,
    `${JSON.stringify(judgment, null, 2)}\n`,
  );

  return {
    reports,
    judgment,
    refs: {
      verification_input: `artifact://${runId}/${inputName}`,
      verifier_runtime: `verifier-runtime://subprocess:${
        executedPhases.join("+") || "none"
      }`,
      // 账本 schema 是单 ref；多份报告落在 verifier-reports 汇总文件
      verifier_report: `artifact://${runId}/${reportsName}`,
      judgment_report: `artifact://${runId}/${judgmentName}`,
    },
  };
}
