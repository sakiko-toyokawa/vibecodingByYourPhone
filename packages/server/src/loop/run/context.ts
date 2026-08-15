/**
 * Execution context builders and rebuild helpers for loop runs.
 *
 * Extracted from run-service.ts during Phase-3 refactoring.
 */

import {
  type IntentContract,
  IntentContractSchema,
  type JudgmentReport,
  type LoopCard,
  type RunStateRecord,
  type RunWorkingState,
  RunWorkingStateSchema,
} from "@yep-anywhere/shared";
import { assembleRuntimeInput } from "../assembly/runtime-input.js";
import { buildIntentContract } from "../contract/intent-contract.js";
import type { ResumeSignal } from "../control-plane/control-plane.js";
import type { ControlPlane } from "../control-plane/control-plane.js";
import type { RunStateStore } from "../control-plane/run-state-store.js";
import type { MaintenanceTargetStore } from "../maintenance/maintenance-target-store.js";
import type { MaintenanceTarget } from "../maintenance/types.js";
import type { RelationLifecycleService } from "../relation/lifecycle-service.js";
import type {
  RelationRecord,
  RelationStore,
} from "../relation/relation-store.js";
import type { FailurePatternStore } from "../state/failure-pattern-store.js";
import type { LoopCardStore } from "../state/loop-card-store.js";
import type { ProposalStore } from "../state/proposal-store.js";
import type { RunLedgerStore } from "../state/run-ledger-store.js";
import { verificationArtifactName } from "../verification/verify-run.js";
import type {
  GithubCredentialStore,
  GithubToolProvisioner,
  RunExecutionContext,
} from "./types.js";
import {
  resolveExecutableCard,
  resolveRuntimeAssemblyContext,
} from "./workspace.js";

export interface RunContextDeps {
  loopCardStore: LoopCardStore;
  runLedgerStore: RunLedgerStore;
  /** Phase 6 checkpoint writing / restart recovery. */
  runStateStore?: RunStateStore;
  controlPlane?: ControlPlane;
  proposalStore?: ProposalStore;
  failurePatternStore?: FailurePatternStore;
  githubCredentialStore?: GithubCredentialStore;
  githubToolProvisioner?: GithubToolProvisioner;
  dataDir?: string;
  relationStore?: RelationStore;
  relationLifecycle?: RelationLifecycleService;
  maintenanceTargetStore?: MaintenanceTargetStore;
}

/**
 * 02 §3 memory packet: 从失败模式账本构建本轮的记忆包——本 loop 相关
 *  (affected_loop_specs 命中或全局) 的 open 模式按出现次数取前 5,
 *  确定性文本注入 prompt, 完整结构落 memory-packet.json artifact
 *  (账本 input_refs.memory_packet 的真实来源, 不再恒 null)。
 * 无 open 模式 / store 未接线时返回 null。
 */
export function buildMemoryPacket(
  card: LoopCard,
  failurePatternStore?: FailurePatternStore,
): { promptText: string; artifactJson: string } | null {
  const store = failurePatternStore;
  if (!store) {
    return null;
  }
  const patterns = store
    .list()
    .filter(
      (pattern) =>
        pattern.status === "open" &&
        (pattern.affected_loop_specs.length === 0 ||
          pattern.affected_loop_specs.includes(card.loop.id)),
    )
    .sort((a, b) => b.occurrence_count - a.occurrence_count)
    .slice(0, 5);
  if (patterns.length === 0) {
    return null;
  }
  return {
    promptText: patterns
      .map(
        (pattern) =>
          `- [${pattern.type}] ${pattern.summary} (seen ${pattern.occurrence_count}x, pattern ${pattern.pattern_id})`,
      )
      .join("\n"),
    artifactJson: `${JSON.stringify(
      {
        loop_id: card.loop.id,
        built_at: new Date().toISOString(),
        patterns: patterns.map((pattern) => ({
          pattern_id: pattern.pattern_id,
          type: pattern.type,
          summary: pattern.summary,
          occurrence_count: pattern.occurrence_count,
          signature: pattern.signature,
        })),
      },
      null,
      2,
    )}\n`,
  };
}

export interface RebuildContextDeps extends RunContextDeps {
  dataDir?: string;
}

/**
 * Rebuild a suspended run's execution context from the stores (server
 * restart path): card from the card store, contract from its artifact
 * snapshot, session ref from the ledger, turn / judgment ref from
 * run_state. Best effort — returns null when any piece is missing.
 */
export async function rebuildContext(
  signal: ResumeSignal,
  deps: RebuildContextDeps,
): Promise<RunExecutionContext | null> {
  const stored = deps.loopCardStore.getLoop(signal.loopId);
  if (!stored || stored.archived) {
    return null;
  }
  const store = deps.runLedgerStore;
  const entry = await store.readEntry(signal.runId);
  let contractJson = await store.readArtifact(
    signal.runId,
    "intent-contract.json",
  );
  const runState = await deps.controlPlane?.getRunState(signal.loopId);
  if (!runState) {
    return null;
  }
  try {
    const { card: executableCard } = await resolveExecutableCard(
      stored.card,
      signal.runId,
      { dataDir: deps.dataDir },
    );
    if (!contractJson) {
      // 首轮在飞时被暂停 (或早于"装配即落盘"版本的 run): turn 1 未产生
      // 合约快照与账本, 按卡片重新装配合约、同 run_id 重新开始。更晚
      // 轮次缺快照则无法忠实重建, 放弃。turn 0 = P5 意圖閘門輪
      // (合約快照已落盤, 正常走上方讀取; 這裡只是兜底)。
      if (runState.turn > 1) {
        return null;
      }
      contractJson = JSON.stringify(
        buildIntentContract(executableCard, {
          runId: signal.runId,
          source:
            stored.card.loop.trigger.type === "schedule" ? "cron" : "manual",
        }),
        null,
        2,
      );
      // 快照落盘: 下次重启直接按正常路径重建, 不再依赖本兜底。
      await store.writeArtifact(
        signal.runId,
        "intent-contract.json",
        contractJson,
      );
    }
    if (!entry && runState.turn > 1) {
      // 缺账本只在首轮暂停时合法 (turn 0/1 未完成本就无 entry; turn 0
      // 是 P5 意圖閘門輪); 更晚轮次缺账本则来源/会话无从确定, 放弃。
      return null;
    }
    const contract = IntentContractSchema.parse(JSON.parse(contractJson));
    const runtimeContext = await resolveRuntimeAssemblyContext(executableCard, {
      githubCredentialStore: deps.githubCredentialStore,
      githubToolProvisioner: deps.githubToolProvisioner,
    });
    const relationJson = await store
      .readArtifact(signal.runId, "relation.json")
      .catch(() => undefined);
    const relation = relationJson
      ? (JSON.parse(relationJson) as RelationRecord)
      : null;
    if (relation) {
      runtimeContext.relation = relation;
    }
    const maintenanceJson = await store
      .readArtifact(signal.runId, "maintenance-target.json")
      .catch(() => undefined);
    const maintenanceTarget = maintenanceJson
      ? (JSON.parse(maintenanceJson) as MaintenanceTarget)
      : null;
    if (maintenanceTarget) {
      runtimeContext.maintenanceTarget = maintenanceTarget;
    }
    const workingStateJson = await store
      .readArtifact(signal.runId, "working-state.json")
      .catch(() => undefined);
    let workingState: RunWorkingState | null = null;
    if (workingStateJson) {
      const parsed = RunWorkingStateSchema.safeParse(
        JSON.parse(workingStateJson),
      );
      if (parsed.success) {
        workingState = parsed.data;
      }
    }
    const memoryPacket = buildMemoryPacket(
      executableCard,
      deps.failurePatternStore,
    );
    if (memoryPacket) {
      runtimeContext.memoryPacket = memoryPacket.promptText;
    }
    // 后续轮的账本 input_refs.memory_packet 仍指向 turn 1 落盘的那份
    // 记忆包 (内容以 turn 1 为准, 不按当前账本重建)。
    const memoryPacketJson =
      (await store
        .readArtifact(signal.runId, "memory-packet.json")
        .catch(() => undefined)) ?? null;
    // 02 §3 budget_remaining: 从 run_state 预算快照算剩余量。
    if (runState.budget) {
      const b = runState.budget;
      runtimeContext.budgetRemaining = {
        max_tokens:
          b.max_tokens > 0 ? Math.max(0, b.max_tokens - b.used_tokens) : 0,
        max_time_minutes: Math.max(0, b.max_time_minutes - b.used_time_minutes),
        max_turns: Math.max(0, b.max_turns - b.used_turns),
        max_retries: Math.max(0, b.max_retries - b.used_retries),
      };
    }
    const input = assembleRuntimeInput(
      executableCard,
      contract,
      deps.proposalStore?.listProposals() ?? [],
      runtimeContext,
      runState.turn,
    );
    let lastJudgment: JudgmentReport | null = null;
    // 按 run_state.turn 读当轮的判定报告 (turn ≥2 落盘为
    // judgment-report-turnN.json) —— 此前固定读 judgment-report.json
    // (turn 1), 重启恢复注入的是过期 judgment 却标着最新 ref。
    const judgmentJson = await store.readArtifact(
      signal.runId,
      verificationArtifactName("judgment-report.json", runState.turn),
    );
    if (judgmentJson) {
      lastJudgment = JSON.parse(judgmentJson) as JudgmentReport;
    }
    // 子任务索引按 subtask_advance 决策计数重建: 推进由已完成子任务数
    // 驱动, 与轮次号解耦 (retry / pause 消耗轮次但不推进子任务, 不能再
    // 用 runState.turn - 1 推导)。budget 护栏挂起的 run 推进决策已落账,
    // 计数同样指向下一子任务, 与内存路径一致。
    const taskPlan = contract.plan ?? null;
    const decisionEntries = await store.readDecisionEntries(signal.runId);
    const waivedPhases = decisionEntries
      .filter((entry) => entry.decision === "waive_phases")
      .flatMap((entry) => entry.waived_phases ?? []);
    let currentSubtaskIndex = 0;
    if (taskPlan) {
      const completedSubtasks = decisionEntries.filter(
        (e) => e.decision === "subtask_advance",
      ).length;
      currentSubtaskIndex = Math.min(
        completedSubtasks,
        taskPlan.subtasks.length - 1,
      );
    }
    return {
      active: {
        runId: signal.runId,
        loopId: signal.loopId,
        // 06 偏差 #28: 触发来源实记账本; 旧条目无该字段时按历史约定
        // 回退 "cron"。首轮暂停无账本时按合约快照还原 (ui→manual)。
        source:
          entry?.source ?? (contract.source === "cron" ? "cron" : "manual"),
        createdAt: entry?.created_at ?? runState.created_at,
      },
      card: executableCard,
      contract,
      contractJson,
      input,
      turn: runState.turn,
      sessionRef: entry
        ? entry.runtime.session_ref === "none"
          ? null
          : entry.runtime.session_ref
        : // 首轮暂停无账本: 暂停时落进 run_state 的 session_ref (06 #32)
          // 仅作最新 session 记录; 续跑时不再 resume 它。
          runState.session_ref,
      lastJudgment,
      lastJudgmentRef: runState.last_judgment,
      pendingContext: null,
      policyEscalations: [],
      permissionEvents: [],
      approvedToolCalls: [],
      memoryPacketJson,
      taskPlan,
      workingState,
      waivedPhases,
      currentSubtaskIndex,
      recentTurnOutputHashes: [],
      recentTurnDiffStatHashes: [],
      recentBlockerFingerprints: [],
      relation,
      maintenanceTarget,
    };
  } catch (error) {
    console.error(
      `[LoopRunService] failed to rebuild context for run ${signal.runId}:`,
      error,
    );
    return null;
  }
}
