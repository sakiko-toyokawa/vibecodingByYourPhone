/**
 * Phase-1 verification orchestration (spec: docs/spec/05-分阶段计划.md 阶段 1
 * "两段起步" + 02-schema契约.md §5/§6).
 *
 * After one run's execution finishes, this walks the card's required
 * verifier chain:
 *   - static / runtime → deterministic subprocess commands (card-pinned
 *     commands first, workspace package.json probing otherwise)
 *   - interaction → browser interaction verification (agent-authored
 *     Playwright script + deterministic subprocess execution)
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
  FailureTag,
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
import { failureTagsFromReports } from "./failure-tags.js";
import { selectVerificationStrategy } from "./strategy-selector.js";
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
  /** Static/runtime phases to skip for this turn. Used for non-code
   *  subtasks where no project has been materialized yet. Skipped phases
   *  are written as not_applicable and do not enter the strategy pipeline
   *  or the aggregate. */
  skipExecutablePhases?: { phase: "static" | "runtime"; reason: string }[];
}

/**
 * P4: 傳給 Verifier Agent 回調的上下文（review phase 專用）。
 * priorReports 是本輪已執行的 L1-L3 報告；下層硬失敗短路時 review
 * 不會被呼叫（省 L4 成本）。previous_judgment 由呼叫方（turn-loop）
 * 在回調閉包內注入 —— verify-run 不知道上一輪裁決。
 */
export interface ReviewAgentContext {
  contract: IntentContract;
  runId: string;
  turn: number;
  workspacePath: string;
  priorReports: VerifierReport[];
  evidenceRefs: {
    diff: string | null;
    stdout: string | null;
    runtime_events: string | null;
    executor_summary: string | null;
  };
}

export interface InteractionAgentContext {
  contract: IntentContract;
  runId: string;
  turn: number;
  workspacePath: string;
  priorReports: VerifierReport[];
  evidenceRefs: {
    diff: string | null;
    stdout: string | null;
    runtime_events: string | null;
    executor_summary: string | null;
  };
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
  /** Phase 7: L3/L4 failure signals mapped to the FailureTag vocabulary. */
  failureTags?: FailureTag[];
}

/** Phases without a direct implementation get a not_applicable placeholder. */
const PLACEHOLDER_PHASES = new Set(["review"]);

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
  deps: {
    store: RunLedgerStore;
    /** 測試注入點 (P0): 缺省用真實策略選擇器。 */
    selectStrategy?: typeof selectVerificationStrategy;
    /**
     * P4: review phase 的 Verifier Agent 回調（read-only judge）。
     * 提供時取代 input.reviewReport / placeholder 路徑；缺省維持
     * P3 以前行為（collector 報告或 not_applicable 占位）。
     */
    runReviewAgent?: (context: ReviewAgentContext) => Promise<VerifierReport>;
    /** Interaction phase runner (agent-authored Playwright script). */
    runInteractionAgent?: (
      context: InteractionAgentContext,
    ) => Promise<VerifierReport>;
  },
): Promise<VerifyRunResult> {
  const { card, contract, runId, workspacePath } = input;
  const { store } = deps;
  const selectStrategy = deps.selectStrategy ?? selectVerificationStrategy;
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

    const skippedPhase = input.skipExecutablePhases?.find(
      (item) => item.phase === phase,
    );
    if (skippedPhase) {
      await store.writeArtifact(
        runId,
        verificationArtifactName(`verifier-report-${phase}.json`, turn),
        `${JSON.stringify(
          {
            verifier_phase: phase,
            status: "not_applicable",
            note: `skipped: ${skippedPhase.reason}`,
          },
          null,
          2,
        )}\n`,
      );
      continue;
    }

    // 可執行 phase 走 strategy 管線; review 仍走 agent / collector 特殊路徑。
    if (
      phase === "static" ||
      phase === "runtime" ||
      phase === "rule" ||
      phase === "structural" ||
      (phase === "interaction" && !deps.runInteractionAgent)
    ) {
      // Use strategy selector to choose the most appropriate verification strategy
      // based on the loop card, intent contract, and workspace contents.
      const strategy = await selectStrategy(
        card,
        contract,
        workspacePath,
        phase,
      );
      // Read artifacts for file-based verification strategies
      const artifacts: Record<string, string> = {};
      const artifactNames = await store.listArtifacts(runId);
      for (const name of artifactNames) {
        const content = await store.readArtifact(runId, name);
        if (content !== undefined) {
          artifacts[name] = content;
        }
      }
      const report = await strategy.verify({
        contract,
        workspacePath,
        exitStatus: input.exitStatus,
        artifacts,
        turn,
        phase,
        timeoutMs: input.timeoutMs,
        writeEvidence,
      });
      // verifier_phase 以编排层当前段为准 (防御性覆盖) —— 策略硬编码
      // "static" 曾让 verifier-report-runtime.json 内容与文件名自相矛盾,
      // test_output_refs (按 runtime 过滤) 恒空。
      const phasedReport = { ...report, verifier_phase: phase };
      reports.push(VerifierReportSchema.parse(phasedReport));
      executedPhases.push(phase);
      await store.writeArtifact(
        runId,
        verificationArtifactName(`verifier-report-${phase}.json`, turn),
        `${JSON.stringify(phasedReport, null, 2)}\n`,
      );
      if (phasedReport.status === "failed") {
        shortCircuitedBy = phase;
      }
      continue;
    }

    if (phase === "interaction" && deps.runInteractionAgent) {
      const interactionReport = VerifierReportSchema.parse({
        ...(await deps.runInteractionAgent({
          contract,
          runId,
          turn,
          workspacePath,
          priorReports: reports,
          evidenceRefs: {
            diff: input.diffRef ?? null,
            stdout: input.stdoutRef,
            runtime_events: input.runtimeEventsRef ?? null,
            executor_summary: input.executorSummaryRef ?? null,
          },
        })),
        verifier_phase: "interaction",
      });
      reports.push(interactionReport);
      executedPhases.push(phase);
      await store.writeArtifact(
        runId,
        verificationArtifactName(`verifier-report-${phase}.json`, turn),
        `${JSON.stringify(interactionReport, null, 2)}\n`,
      );
      if (interactionReport.status === "failed") {
        shortCircuitedBy = phase;
      }
      continue;
    }

    // P4: review 段有 Verifier Agent 回調時走 agent 管線（read-only
    // judge；下層硬失敗短路時不會到這裡）。agent 報告與其他 phase 同權
    // 參與聚合, failed 同樣觸發短路。
    if (phase === "review" && deps.runReviewAgent) {
      const agentReport = VerifierReportSchema.parse({
        ...(await deps.runReviewAgent({
          contract,
          runId,
          turn,
          workspacePath,
          priorReports: reports,
          evidenceRefs: {
            diff: input.diffRef ?? null,
            stdout: input.stdoutRef,
            runtime_events: input.runtimeEventsRef ?? null,
            executor_summary: input.executorSummaryRef ?? null,
          },
        })),
        verifier_phase: "review",
      });
      reports.push(agentReport);
      executedPhases.push(phase);
      await store.writeArtifact(
        runId,
        verificationArtifactName(`verifier-report-${phase}.json`, turn),
        `${JSON.stringify(agentReport, null, 2)}\n`,
      );
      if (agentReport.status === "failed") {
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
    failureTags: failureTagsFromReports(reports),
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
