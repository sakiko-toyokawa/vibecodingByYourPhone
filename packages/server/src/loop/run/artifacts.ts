/**
 * Artifact and evidence helpers for loop runs.
 *
 * Extracted from run-service.ts during Phase-3 refactoring.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type {
  CollectorReport,
  HumanReason,
  JudgmentReport,
  LoopCard,
} from "@yep-anywhere/shared";
import { CollectorReportSchema, TurnHandoffSchema } from "@yep-anywhere/shared";
import type { Process } from "../../supervisor/Process.js";
import type { Supervisor } from "../../supervisor/Supervisor.js";
import type { QueueFullResponse } from "../../supervisor/Supervisor.js";
import type { QueuedResponse } from "../../supervisor/WorkerQueue.js";
import { resolveAdapterPolicy } from "../assembly/adapter-policy.js";
import type { RuntimeInput } from "../assembly/runtime-input.js";
import type { RunLedgerStore } from "../state/run-ledger-store.js";
import { verificationArtifactName } from "../verification/verify-run.js";
import type { CollectorOutcome, RunExecutionContext } from "./types.js";
import { loopRuntime } from "./workspace.js";

export function buildCollectorPrompt(
  inputRef: string,
  bundle: unknown,
): string {
  const artifactDir =
    typeof bundle === "object" && bundle !== null
      ? (bundle as { artifact_dir?: unknown }).artifact_dir
      : null;
  return [
    "Collector input bundle:",
    JSON.stringify(bundle, null, 2),
    "",
    `Read ${inputRef} as the durable input reference. Independently inspect only the evidence needed to review this turn. Stay read-only and finish with a concise evidence report.`,
    ...(typeof artifactDir === "string"
      ? [
          "",
          `Artifacts for this run live in: ${artifactDir}`,
          "Use Read/Glob/Grep for artifact inspection. Do not use Bash to enumerate server-managed directories.",
        ]
      : []),
  ].join("\n");
}

export function mergeEvidence(
  judgment: JudgmentReport,
  extraRefs: (string | null)[],
  collectorReport?: CollectorReport | null,
): JudgmentReport {
  const evidence = Array.from(
    new Set([
      ...judgment.evidence,
      ...extraRefs.filter((ref): ref is string => Boolean(ref)),
    ]),
  );
  const humanReasons: HumanReason[] = [
    ...(judgment.human_reasons ?? []),
    ...(collectorReport?.human_reasons ?? []),
  ];
  return {
    ...judgment,
    evidence,
    ...(humanReasons.length > 0 ? { human_reasons: humanReasons } : {}),
  };
}

const execFileAsync = promisify(execFile);

/**
 * Capture the workspace's full diff against HEAD (staged + unstaged) for
 * the verification input's evidence_refs.diff (02 §5, 04: diff.patch
 * 永久保留). Returns null when the workspace is not a git repo, git is
 * unavailable, or the turn produced no changes — never fabricates a diff.
 */
export async function captureGitDiff(
  workspacePath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspacePath, "diff", "HEAD"],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout.trim().length > 0 ? stdout : null;
  } catch {
    return null;
  }
}

/** diff_summary 截断上限: 避免巨型 --stat 输出灌进 WS 事件。 */
const DIFF_SUMMARY_MAX_CHARS = 500;

/**
 * run-decision-required 事件的 diff_summary: 工作区相对基线的
 * git diff --stat 摘要文本。worktree 策略基线传 baseSha (含 loop 分支
 * 已提交改动), direct 策略缺省对 HEAD。与 captureGitDiff 同口径: 不含
 * 未跟踪新文件 (--stat 限制, 与 diff.patch 证据一致); 非 git 工作区 /
 * git 不可用 / 无变更时返回 null, 不伪造 — 该字段只是审批展示的辅助
 * 信息, 失败即省略, 绝不阻断控制决策。
 */
export async function captureGitDiffStat(
  workspacePath: string,
  baseRef?: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspacePath, "diff", "--stat", baseRef ?? "HEAD"],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
      return null;
    }
    return trimmed.length > DIFF_SUMMARY_MAX_CHARS
      ? `${trimmed.slice(0, DIFF_SUMMARY_MAX_CHARS)}…`
      : trimmed;
  } catch {
    return null;
  }
}

export interface RunCollectorDeps {
  supervisor: Supervisor;
  runLedgerStore: RunLedgerStore;
  watchProcess: (
    runId: string,
    proc: Process,
    opts: { timeoutMs?: number },
  ) => Promise<{
    ok: boolean;
    finalText: string;
    error?: string;
    usage?: { tokens: number } | null;
  }>;
}

export async function runCollector(
  deps: RunCollectorDeps,
  ctx: RunExecutionContext,
  outcome: { ok: boolean },
  stdoutRef: string,
): Promise<CollectorOutcome> {
  if (!ctx.input || !ctx.contract) {
    return { inputRef: null, outputRef: null, reportRef: null, report: null };
  }
  const { runId, loopId } = ctx.active;
  const inputName =
    ctx.turn === 1
      ? "collector-input.json"
      : `collector-input-turn${ctx.turn}.json`;
  const outputName =
    ctx.turn === 1
      ? "collector-output.log"
      : `collector-output-turn${ctx.turn}.log`;
  const reportName =
    ctx.turn === 1
      ? "collector-report.json"
      : `collector-report-turn${ctx.turn}.json`;
  const artifactDir = deps.runLedgerStore.artifactsDirFor(runId);
  const artifactGlobs = [artifactDir, artifactDir.replace(/\\/g, "/")].filter(
    (dir, index, dirs) => dirs.indexOf(dir) === index,
  );
  const collectorPermissions = {
    ...ctx.input.permissions,
    allow: [
      ...(ctx.input.permissions.allow ?? []),
      ...artifactGlobs.flatMap((dir) => [
        `Read(*${dir}*)`,
        `Glob(*${dir}*)`,
        `Grep(*${dir}*)`,
      ]),
    ],
  };
  const inputBundle = {
    run_id: runId,
    loop_id: loopId,
    turn: ctx.turn,
    task_type: ctx.contract.task_type.primary,
    workspace_ref: `workspace://${loopId}/${runId}`,
    workspace_path: ctx.input.cwd,
    artifact_dir: artifactDir,
    stdout_ref: stdoutRef,
    execution_ok: outcome.ok,
    max_items_per_run: ctx.card.loop.handoff?.max_items_per_run ?? null,
    previous_judgment_ref: ctx.lastJudgmentRef,
    previous_unresolved_risks: ctx.lastJudgment?.unresolved_risks ?? [],
  };
  const inputJson = `${JSON.stringify(inputBundle, null, 2)}\n`;
  await deps.runLedgerStore.writeArtifact(runId, inputName, inputJson);
  const inputRef = `artifact://${runId}/${inputName}`;

  let collectorOutput = "";
  let collectorOk = false;
  try {
    const message = {
      text: buildCollectorPrompt(inputRef, inputBundle),
      mode: "plan" as const,
    };
    // collector 也是 adapter 调用 (02 §3): adapter_policy 的 model 覆盖
    // 与轮次超时同样适用 —— 挂死的 collector 不得挂死整个 run。
    const adapterPolicy = resolveAdapterPolicy(ctx.input.adapterPolicy);
    const result = await deps.supervisor.startSession(
      ctx.input.cwd,
      message,
      "plan",
      {
        permissions: collectorPermissions,
        env: ctx.input.env,
        providerName: loopRuntime(ctx.card)?.provider as
          | import("@yep-anywhere/shared").ProviderName
          | undefined,
        model: adapterPolicy.model ?? loopRuntime(ctx.card)?.model,
      },
    );
    if ("error" in result || "queued" in result) {
      collectorOutput =
        "collector could not start: supervisor queue unavailable";
    } else {
      const collected = await deps.watchProcess(runId, result as Process, {
        timeoutMs:
          adapterPolicy.timeoutMs ??
          (ctx.input.nativeInvocation.timeout_seconds
            ? ctx.input.nativeInvocation.timeout_seconds * 1000
            : undefined),
      });
      collectorOk = collected.ok;
      collectorOutput =
        collected.finalText ||
        collected.error ||
        "(collector produced no output)";
      if (collected.usage) {
        const usageName =
          ctx.turn === 1
            ? "collector-usage.json"
            : `collector-usage-turn${ctx.turn}.json`;
        await deps.runLedgerStore.writeArtifact(
          runId,
          usageName,
          `${JSON.stringify({ tokens: collected.usage.tokens })}\n`,
        );
      }
    }
  } catch (error) {
    collectorOutput =
      error instanceof Error
        ? error.message
        : `collector failed: ${String(error)}`;
  }

  await deps.runLedgerStore.writeArtifact(runId, outputName, collectorOutput);
  const outputRef = `artifact://${runId}/${outputName}`;
  const report = CollectorReportSchema.parse({
    collector_phase: "review",
    status: collectorOk ? "passed" : "inconclusive",
    evidence_refs: [outputRef],
    unresolved_risks: collectorOk
      ? []
      : ["collector did not complete with a successful result"],
    recommendation: collectorOk ? "stop" : "escalate",
    confidence: collectorOk ? 0.7 : 0.2,
    requires_human: !collectorOk,
    summary: collectorOutput,
    human_reasons: collectorOk
      ? []
      : [
          {
            code: "collector_failed",
            message: "Collector did not complete with a successful result.",
            evidence_refs: [outputRef],
          },
        ],
  });
  await deps.runLedgerStore.writeArtifact(
    runId,
    reportName,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return {
    inputRef,
    outputRef,
    reportRef: `artifact://${runId}/${reportName}`,
    report,
  };
}

export interface BuildHumanFeedbackRefsDeps {
  runLedgerStore: RunLedgerStore;
}

export async function buildHumanFeedbackRefs(
  deps: BuildHumanFeedbackRefsDeps,
  runId: string,
): Promise<string[]> {
  const decisions = await deps.runLedgerStore.readDecisionEntries(runId);
  const withFeedback = decisions.filter(
    (decision) =>
      decision.feedback !== undefined || decision.override !== undefined,
  );
  if (withFeedback.length === 0) {
    return [];
  }
  const name = "human-feedback.json";
  const content = {
    run_id: runId,
    entries: withFeedback.map((decision) => ({
      decision_id: decision.decision_id,
      decision: decision.decision,
      reason: decision.reason,
      feedback: decision.feedback ?? null,
      override: decision.override ?? null,
      created_at: decision.created_at,
    })),
  };
  await deps.runLedgerStore.writeArtifact(
    runId,
    name,
    `${JSON.stringify(content, null, 2)}\n`,
  );
  return [`artifact://${runId}/${name}`];
}

export interface WriteTurnHandoffDeps {
  runLedgerStore: RunLedgerStore;
}

export async function writeTurnHandoff(
  deps: WriteTurnHandoffDeps,
  ctx: RunExecutionContext,
  refs: {
    collectorReportRef: string | null;
    judgmentRef: string | null;
    evidenceRefs: string[];
    blockerFingerprint?: string;
    repeatedBlockerCount?: number;
  },
): Promise<string> {
  const name =
    ctx.turn === 1 ? "turn-handoff.json" : `turn-handoff-turn${ctx.turn}.json`;
  const handoff = TurnHandoffSchema.parse({
    run_id: ctx.active.runId,
    loop_id: ctx.active.loopId,
    turn: ctx.turn,
    workspace_ref: `workspace://${ctx.active.loopId}/${ctx.active.runId}`,
    session_ref: ctx.sessionRef,
    judgment_ref: refs.judgmentRef,
    collector_report_ref: refs.collectorReportRef,
    blocker_fingerprint: refs.blockerFingerprint ?? null,
    repeated_blocker_count: refs.repeatedBlockerCount ?? null,
    evidence_refs: refs.evidenceRefs,
    next_required_checks: ctx.card.loop.verification.required,
    actions_not_to_repeat: [],
    created_at: new Date().toISOString(),
  });
  await deps.runLedgerStore.writeArtifact(
    ctx.active.runId,
    name,
    `${JSON.stringify(handoff, null, 2)}\n`,
  );
  return `artifact://${ctx.active.runId}/${name}`;
}

export { verificationArtifactName };
