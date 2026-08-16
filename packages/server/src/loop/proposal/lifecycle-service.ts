/**
 * LoopProposalLifecycleService — LOOP-PROPOSAL 閘門的唯一寫者
 * （loop-self-proposal-gate 计划 P1-3/P1-4）。
 *
 * 类比 RelationLifecycleService：生产者（run 完成兜底注册、approve /
 * reject 路由）发命令，服务负责钳制、配额硬顶、持久化、learning 账与
 * loop-proposal-changed 事件广播。
 *
 * 状态机：pending_approval → approved / rejected。配额超限的提案直接
 * rejected + 记 learning event，不进人工队列。
 */

import type { LearningEvent } from "@yep-anywhere/shared";
import type { IEventBus } from "../../watcher/index.js";
import type { LearningEventStore } from "../state/learning-event-store.js";
import type { LoopCardStore } from "../state/loop-card-store.js";
import {
  type LoopProposalRecord,
  type LoopProposalState,
  type LoopProposalStore,
  appendLoopProposalStateLog,
} from "./loop-proposal-store.js";
import {
  LOOP_PROPOSAL_DAILY_LIMIT,
  LOOP_PROPOSAL_MAX_ACTIVE_LOOPS,
  clampProposedCard,
  extractLoopProposalPayload,
} from "./loop-proposal.js";

export interface LoopProposalLifecycleDeps {
  proposalStore: LoopProposalStore;
  loopCardStore: LoopCardStore;
  eventBus?: IEventBus;
  /** learning 账本（02 §8.4）；缺席时配额/拒绝事件只进 state_logs。 */
  learningEventStore?: LearningEventStore;
  /** 配额硬顶（P1-4）；测试可注入更小的上限。 */
  dailyProposalLimit?: number;
  maxActiveLoops?: number;
}

export interface LoopProposalLogInput {
  event: string;
  message: string;
}

/** approve 的返回值：null = 提案不存在；其余字面量为可预期的冲突。 */
export type LoopProposalApproveResult =
  | LoopProposalRecord
  | null
  | "invalid_state"
  | "loop_exists";

/** reject 的返回值：null = 提案不存在；"invalid_state" = 不在 pending_approval。 */
export type LoopProposalRejectResult =
  | LoopProposalRecord
  | null
  | "invalid_state";

export class LoopProposalLifecycleService {
  private readonly deps: LoopProposalLifecycleDeps;

  constructor(deps: LoopProposalLifecycleDeps) {
    this.deps = deps;
  }

  /**
   * Register a LOOP-PROPOSAL handoff from a run's final text. 解析失败、
   * 父 loop 未授权（can_propose_loops）或钳制层硬违规时丢弃（返回 null，
   * 不落库）；配额超限时落一条 rejected 记录（不进人工队列）并记
   * learning event；正常提案泊入 pending_approval 等待人工批准。
   */
  async registerLoopProposal(
    loopId: string,
    runId: string,
    finalText: string,
  ): Promise<LoopProposalRecord | null> {
    const payload = extractLoopProposalPayload(finalText);
    if (!payload) {
      return null;
    }
    const parent = this.deps.loopCardStore.getLoop(loopId);
    if (!parent) {
      console.warn(
        `[LoopProposalLifecycle] dropping proposal from unknown loop '${loopId}'`,
      );
      return null;
    }
    if (parent.card.loop.can_propose_loops !== true) {
      console.warn(
        `[LoopProposalLifecycle] dropping proposal from loop '${loopId}': can_propose_loops is not granted`,
      );
      return null;
    }
    const clamped = clampProposedCard(payload.card, parent.card);
    if (!clamped.ok || !clamped.card) {
      console.warn(
        `[LoopProposalLifecycle] dropping proposal from loop '${loopId}': ${clamped.violations.join("; ")}`,
      );
      return null;
    }

    const now = new Date().toISOString();
    const proposalId = `loopprop-${loopId}-${runId}`;
    // 幂等：同一 run 重复注册（restart recovery 会重跑完成路径）时直接
    // 返回现状；终态（approved/rejected）提案不许复活回 pending_approval——
    // 与 relation 侧「dismissed 不复活」同一教训（ff979e4）。
    const existing = this.deps.proposalStore.findById(proposalId);
    if (existing) {
      return existing.state === "pending_approval" ? existing : null;
    }
    const base: LoopProposalRecord = {
      proposal_id: proposalId,
      loop_id: loopId,
      run_id: runId,
      parent_loop_id: loopId,
      reason: payload.reason,
      card: clamped.card,
      state: "pending_approval",
      state_logs: [],
      created_at: now,
      updated_at: now,
    };

    // 配额硬顶（P1-4）：每日提案数 / 全局活跃 loop 数。超限直接
    // rejected + learning event，不进人工队列。
    const quotaViolation = this.checkQuota(now);
    if (quotaViolation) {
      return this.persist(
        base,
        "rejected",
        {
          rejection_reason: quotaViolation,
        },
        {
          event: "quota_exceeded",
          message: quotaViolation,
        },
        null,
      );
    }
    return this.persist(
      base,
      "pending_approval",
      {},
      {
        event: "pending_approval",
        message: `run ${runId} proposed loop '${clamped.card.loop.id}': ${payload.reason}`,
      },
      null,
    );
  }

  /**
   * 人工批准：用钳制后的 card 创建 loop，提案转 approved 并记
   * created loop_id。card id 已被占用时返回 "loop_exists"（路由 409）。
   */
  async approve(
    proposalId: string,
    log?: LoopProposalLogInput,
  ): Promise<LoopProposalApproveResult> {
    const current = this.deps.proposalStore.findById(proposalId);
    if (!current) {
      return null;
    }
    if (current.state !== "pending_approval") {
      return "invalid_state";
    }
    if (this.deps.loopCardStore.getLoop(current.card.loop.id)) {
      return "loop_exists";
    }
    await this.deps.loopCardStore.createLoop(current.card);
    return this.persist(
      current,
      "approved",
      {
        created_loop_id: current.card.loop.id,
      },
      log ?? {
        event: "approved",
        message: `human approved; loop '${current.card.loop.id}' created`,
      },
      current.state,
    );
  }

  /** 人工拒绝：提案转 rejected 并带理由进 learning 账本。 */
  async reject(
    proposalId: string,
    reason?: string,
  ): Promise<LoopProposalRejectResult> {
    const current = this.deps.proposalStore.findById(proposalId);
    if (!current) {
      return null;
    }
    if (current.state !== "pending_approval") {
      return "invalid_state";
    }
    return this.persist(
      current,
      "rejected",
      {
        rejection_reason: reason ?? "rejected by human",
      },
      {
        event: "rejected",
        message: reason
          ? `human rejected the loop proposal — ${reason}`
          : "human rejected the loop proposal",
      },
      current.state,
    );
  }

  /**
   * 每日提案数按 UTC 日统计（含 rejected——配额防的是提案洪水本身）；
   * 活跃 loop 数 = 注册表内未归档 loop 总数。
   */
  private checkQuota(nowIso: string): string | null {
    const dailyLimit =
      this.deps.dailyProposalLimit ?? LOOP_PROPOSAL_DAILY_LIMIT;
    const today = nowIso.slice(0, 10);
    const todayCount = this.deps.proposalStore
      .list()
      .filter((proposal) => proposal.created_at.slice(0, 10) === today).length;
    if (todayCount >= dailyLimit) {
      return `quota_exceeded: daily loop proposal limit reached (${dailyLimit}/day)`;
    }
    const maxActiveLoops =
      this.deps.maxActiveLoops ?? LOOP_PROPOSAL_MAX_ACTIVE_LOOPS;
    const activeLoops = this.deps.loopCardStore.listLoops().length;
    if (activeLoops >= maxActiveLoops) {
      return `quota_exceeded: active loop limit reached (${maxActiveLoops} loops)`;
    }
    return null;
  }

  private async persist(
    base: LoopProposalRecord,
    toState: LoopProposalState,
    patch: Partial<LoopProposalRecord>,
    log: LoopProposalLogInput,
    /** 迁移前状态；新提案（注册入闸）为 null。 */
    fromState: LoopProposalState | null,
  ): Promise<LoopProposalRecord> {
    const now = new Date().toISOString();
    const merged: LoopProposalRecord = {
      ...base,
      ...patch,
      state: toState,
      updated_at: now,
    };
    merged.state_logs = appendLoopProposalStateLog(
      merged,
      log.event,
      log.message,
      now,
    );
    const saved = await this.deps.proposalStore.upsert(merged);
    this.emitProposalChanged(saved, fromState, log);
    if (toState === "rejected") {
      await this.appendLearningEvent(saved);
    }
    return saved;
  }

  /** learning 账本（02 §8.4）：拒绝/配额事件进 events.jsonl；失败只记日志不外抛。 */
  private async appendLearningEvent(
    proposal: LoopProposalRecord,
  ): Promise<void> {
    const store = this.deps.learningEventStore;
    if (!store) {
      return;
    }
    const event: LearningEvent = {
      event_id: `${proposal.proposal_id}-${proposal.state}`,
      run_id: proposal.run_id,
      loop_id: proposal.loop_id,
      decision: "policy_blocked",
      judgment_ref: "not_available",
      ledger_refs: [],
      failure_tags: ["policy_error"],
      created_at: new Date().toISOString(),
    };
    await store.appendEvent(event).catch((error) => {
      console.error(
        "[LoopProposalLifecycle] failed to append learning event:",
        error,
      );
    });
  }

  private emitProposalChanged(
    proposal: LoopProposalRecord,
    fromState: LoopProposalState | null,
    log?: LoopProposalLogInput,
  ): void {
    this.deps.eventBus?.emit({
      type: "loop-proposal-changed",
      proposal_id: proposal.proposal_id,
      loop_id: proposal.loop_id,
      from_state: fromState,
      to_state: proposal.state,
      event: log?.event,
      message: log?.message,
      proposal,
      timestamp: proposal.updated_at,
    });
  }
}
