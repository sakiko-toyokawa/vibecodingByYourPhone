/**
 * Learning worker (spec: docs/spec/05-分阶段计划.md 阶段 3,
 * loop-engineering/loop-state-and-learning/失败模式账本.md + 改进提案.md).
 *
 * 阶段 3 第二刀: worker 本体. 与主链路同进程, 用 setInterval 定时消费
 * learning/events.jsonl (05 风险节: "同进程时定时任务崩溃要能被隔离
 * (try/catch + 账本记录), 或独立 entry —— 二选一", 本刀选同进程 +
 * 崩溃隔离):
 *
 * - 崩溃隔离: 每轮 tick 整体 try/catch, 异常只记日志 + 更新内存健康记录
 *   (getHealth), tick 永不 reject, 绝不影响 run 推进. 单事件处理失败
 *   (毒事件) 也只记日志跳过, cursor 照常推进不阻塞后续事件.
 * - 读写边界 (04 单写者表): 只读 events.jsonl + runs/ + artifacts/
 *   (决策账本 reason / judgment 作指纹证据), 只写 failure-patterns.json、
 *   proposals/、cursor.json —— worker 不写账本主链路任何文件.
 *
 * 聚类 (确定性预聚合, 见 signature.ts): 同 failure tag + 同归一化错误指纹
 * 进同一个桶. 单次失败不进模式层 (失败模式账本.md): 同签名事件按 run 去重
 * 计数, 达到 patternMinOccurrences (默认 2) 且跨 minDistinctRuns (默认 1)
 * 个不同 run 才创建/更新 failure_pattern. 出现次数按 run 去重 —— 一次 run
 * 内反复报同一错误算一次发作, 因此默认阈值 2 实际意味着至少跨 2 个 run
 * (强于 05 字面的 "跨 ≥1 个不同 run", 符合 "同类失败重复出现" 语义).
 *
 * 提案 (改进提案.md): open 且 occurrence_count >= proposalMinOccurrences
 * (默认 3) 的 pattern 生成 ImprovementProposal —— 提案阈值高于入账本阈值,
 * 理由是提案会进入发布管线消耗 shadow/canary 资源, 需要更强的复发证据
 * ("从证据生成, 不从单次成功生成"). type 按归因类别查
 * ATTRIBUTION_TO_PROPOSAL 映射表, summary/expected_effect 用模板化文字,
 * 不调用 LLM. 去重: proposal id 由 pattern id 确定性派生, 已存在 (任意
 * 状态) 即跳过 —— 提案 schema 没有计数字段, 且 store.create 会重置
 * history, 所以 "更新而非新建" 落地为 "不重复新建"; 被拒绝后的再提案
 * 留给人工作后续刀.
 *
 * 已知限制: 未达阈值的桶只保存在内存, worker 重启丢失 (事件仍在
 * events.jsonl, 重置 cursor 可重放; 已达阈值的 pattern 持久化且按
 * evidence_runs 去重, 重放安全).
 */

import type {
  FailurePattern,
  FailureTag,
  ImprovementProposal,
  LearningEvent,
  ProposalRisk,
  ProposalType,
} from "@yep-anywhere/shared";
import { JudgmentReportSchema } from "@yep-anywhere/shared";
import type { RunStateStore } from "../control-plane/run-state-store.js";
import { runLoopStorageCleanup } from "../state/cleanup.js";
import type { FailurePatternStore } from "../state/failure-pattern-store.js";
import type { LearningEventStore } from "../state/learning-event-store.js";
import type { LoopCardStore } from "../state/loop-card-store.js";
import type { ProposalStore } from "../state/proposal-store.js";
import type { RunLedgerStore } from "../state/run-ledger-store.js";
import { pruneStaleWorktrees } from "../worktree/worktree.js";
import type { EvalCase, EvalRunner } from "./eval-runner.js";
import type { ProposalPipeline } from "./pipeline.js";
import { buildSignature, patternIdFor, proposalIdFor } from "./signature.js";

/**
 * worktree 清理的 run 态保护集 (04: 恢复依赖 worktree 的阻塞/活跃态)。
 * 与 state/cleanup.ts 的 PROTECTED_STATES 不同: 不含 budget_limited
 * (该态恢复路径是预算重置后开新 run, 不回原 worktree)。
 */
const WORKTREE_PROTECTED_STATES = new Set([
  "active",
  "retry",
  "paused",
  "needs_human",
]);

/** 归因类别 → 提案类型 / 风险 / target 提示 (映射表, 改进提案.md 7 类型). */
export const ATTRIBUTION_TO_PROPOSAL: Record<
  FailureTag,
  { type: ProposalType; risk: ProposalRisk; targetHint: string }
> = {
  // 意图合约错误或模糊 → 改 loop spec 的合约/范围/停止规则
  intent_error: {
    type: "loop_spec_proposal",
    risk: "medium",
    targetHint: "intent_contract",
  },
  // runtime 黑盒不可解释/不可恢复 → 改 adapter 调用方式 (如超时配置)
  runtime_blackbox_error: {
    type: "runtime_adapter_proposal",
    risk: "medium",
    targetHint: "adapter.timeout_config",
  },
  // Runtime Input Bundle 缺关键信息 → 改注入模板
  context_error: {
    type: "memory_packet_template_proposal",
    risk: "low",
    targetHint: "memory_packet_template",
  },
  // 注入的摘要过期/冲突/误导 → 改注入模板
  memory_packet_error: {
    type: "memory_packet_template_proposal",
    risk: "low",
    targetHint: "memory_packet_template",
  },
  // runtime 工具调用失败/不可观测 → 改 adapter 工具配置
  tool_error: {
    type: "runtime_adapter_proposal",
    risk: "low",
    targetHint: "adapter.tool_config",
  },
  // 外层策略过宽/过窄 → 改策略档 (高影响, 必须人工审查)
  policy_error: {
    type: "policy_profile_proposal",
    risk: "high",
    targetHint: "policy_profile",
  },
  // verifier 误判/证据不足 → 改 verifier 规则或门槛
  verification_error: {
    type: "verification_rule_proposal",
    risk: "medium",
    targetHint: "verifier_rubric",
  },
  // benchmark/regression 变差 → 把失败样本加入 eval 集
  eval_regression: {
    type: "eval_task_proposal",
    risk: "medium",
    targetHint: "eval_regression_suite",
  },
};

export interface LearningWorkerDeps {
  learningEventStore: LearningEventStore;
  failurePatternStore: FailurePatternStore;
  proposalStore: ProposalStore;
  runLedgerStore: RunLedgerStore;
  /**
   * 阶段 3 第三刀: 发布管线 (可选)。挂上后每轮 tick 在提案生成之后自动
   * 推进档位 draft→shadow→canary (regression 档复跑 eval 最小集);
   * approved/published 无自动路径 (人工闸门在 routes/proposals.ts)。
   */
  pipeline?: ProposalPipeline;
  /**
   * 04 容量与清理: 顺带清理需要扫描活跃 run 状态 (可选; 缺席时不做
   * 清理, 保持 phase-3 测试挂载兼容)。
   */
  runStateStore?: RunStateStore;
  /** golden task 同步: 失败模式 → eval 集的 card 查询 (可选)。 */
  loopCardStore?: LoopCardStore;
  /** golden task 同步: eval 集写入入口 (可选)。 */
  evalRunner?: EvalRunner;
  /**
   * 04 容量与清理: worktree 清理的数据目录 (可选; 缺席时回退默认
   * ~/.yep-anywhere, 与各 store 同口径)。
   */
  dataDir?: string;
}

export interface LearningWorkerConfig {
  /** 定时间隔 (默认 60s) */
  intervalMs?: number;
  /** 进模式层的出现次数阈值 (默认 2 —— 单次失败不进模式层) */
  patternMinOccurrences?: number;
  /** 进模式层的不同 run 数下限 (默认 1; 按 run 去重计数后实际 ≥ 阈值) */
  minDistinctRuns?: number;
  /** 可提案的出现次数阈值 (默认 3 —— 提案消耗发布管线资源, 需更强证据) */
  proposalMinOccurrences?: number;
  /** 存储清理的节流间隔 (默认 1h; 清理涉及全量账本扫描, 不随 tick 高频跑) */
  cleanupIntervalMs?: number;
  /** 时钟注入 (测试用) */
  now?: () => Date;
}

/** worker 健康记录 (内存态, 崩溃隔离的可观测面; 不落盘以遵守单写者表). */
export interface WorkerHealth {
  ticksTotal: number;
  eventsProcessed: number;
  consecutiveFailures: number;
  lastTickStartedAt?: string;
  lastTickFinishedAt?: string;
  lastErrorAt?: string;
  lastError?: string;
}

/** 未达阈值的内存桶 (单次失败不进模式层, 也不落盘). */
interface PendingBucket {
  tag: FailureTag;
  signature: string;
  runs: Set<string>;
  loops: Set<string>;
  firstSeenAt: string;
  sampleText: string;
}

export class LearningWorker {
  private readonly deps: LearningWorkerDeps;
  private readonly config: Required<Omit<LearningWorkerConfig, "now">>;
  private readonly now: () => Date;
  private readonly pending = new Map<string, PendingBucket>();
  private readonly health: WorkerHealth = {
    ticksTotal: 0,
    eventsProcessed: 0,
    consecutiveFailures: 0,
  };
  private readonly initPromise: Promise<void>;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  /** 上次存储清理时间 (epoch ms; 0 = 本进程未跑过, 首个 tick 即跑) */
  private lastCleanupAt = 0;

  constructor(deps: LearningWorkerDeps, config: LearningWorkerConfig = {}) {
    this.deps = deps;
    this.config = {
      intervalMs: config.intervalMs ?? 60_000,
      patternMinOccurrences: config.patternMinOccurrences ?? 2,
      minDistinctRuns: config.minDistinctRuns ?? 1,
      proposalMinOccurrences: config.proposalMinOccurrences ?? 3,
      cleanupIntervalMs: config.cleanupIntervalMs ?? 60 * 60 * 1000,
    };
    this.now = config.now ?? (() => new Date());
    // 存储加载是容错设计 (损坏即备份并从空开始); 这里再兜一层,
    // 初始化失败也不能让 worker 起不来.
    this.initPromise = Promise.all([
      deps.failurePatternStore.initialize(),
      deps.proposalStore.initialize(),
    ])
      .then(() => undefined)
      .catch((error) => {
        console.error(
          "[LearningWorker] store initialization failed; starting with empty state:",
          error,
        );
      });
  }

  /** Start the periodic consumption loop (idempotent). */
  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.intervalMs);
    // Do not keep the process alive just for the worker
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 健康记录 (崩溃隔离的可观测面). */
  getHealth(): WorkerHealth {
    return { ...this.health };
  }

  /**
   * One consumption round. NEVER rejects: the whole body is wrapped so a
   * crashing tick is logged + recorded in health and nothing else (05:
   * worker 崩溃不影响 run 推进). Overlapping ticks are skipped.
   */
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    this.health.ticksTotal += 1;
    this.health.lastTickStartedAt = this.now().toISOString();
    try {
      await this.initPromise;
      const cursor = await this.deps.learningEventStore.readCursor();
      const { events, nextOffset } =
        await this.deps.learningEventStore.readEvents(cursor);
      for (const event of events) {
        try {
          await this.processEvent(event);
          this.health.eventsProcessed += 1;
        } catch (error) {
          // 毒事件: 记日志跳过, 不阻塞后续事件, cursor 照常推进
          console.warn(
            `[LearningWorker] skipping poison event ${event.event_id} (run ${event.run_id}):`,
            error,
          );
        }
      }
      if (nextOffset !== cursor) {
        await this.deps.learningEventStore.writeCursor(nextOffset);
      }
      await this.generateProposals();
      // 发布管线自动推进 (draft→shadow→canary; 元规则保护与 fail-closed
      // regression 都在 pipeline 内)。异常由外层 tick catch 隔离。
      await this.deps.pipeline?.advanceEligible();
      // failure_pattern 生命周期收口 (02 §8.3 open→resolved): 来源提案
      // 到达 published 即该模式已被处置。
      await this.resolvePublishedPatterns();
      // golden tasks: 失败模式衍生的可复跑用例并入 eval 集 (基准与回归.md:
      // 失败样本进 benchmark)。
      await this.syncGoldenCases();
      // 04 容量与清理: 节流顺带执行 (worker 是唯一的定期后台任务)。
      await this.maybeRunCleanup();
      this.health.consecutiveFailures = 0;
      this.health.lastTickFinishedAt = this.now().toISOString();
    } catch (error) {
      // 崩溃隔离: 一轮 tick 的任何异常只落在日志 + 健康记录里
      console.error(
        "[LearningWorker] tick failed (isolated; run 主链路不受影响):",
        error,
      );
      this.health.consecutiveFailures += 1;
      this.health.lastErrorAt = this.now().toISOString();
      this.health.lastError =
        error instanceof Error ? error.message : String(error);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * failure_pattern 生命周期收口 (02 §8.3 status open→resolved): 来源
   * 提案走完管线到达 published 即视为该模式已被处置 —— 每轮 tick 把
   * published 提案的 source_patterns 标记为 resolved (幂等: 已
   * resolved 的跳过不写)。回滚不自动重开: 模式复发会按签名再次入账
   * (occurrence_count 继续累计), 由提案机制再处置。
   */
  private async resolvePublishedPatterns(): Promise<void> {
    for (const proposal of this.deps.proposalStore.listProposals("published")) {
      for (const patternId of proposal.source_patterns) {
        const pattern = this.deps.failurePatternStore.get(patternId);
        if (pattern && pattern.status === "open") {
          await this.deps.failurePatternStore.upsert({
            ...pattern,
            status: "resolved",
          });
        }
      }
    }
  }

  /**
   * 04 容量与清理: 按 cleanupIntervalMs 节流顺带执行 (账本 20 轮压缩、
   * artifacts 随账本裁剪、events.jsonl 30 天截断、超期 run worktree 清理;
   * 活跃 run 全程保护)。runStateStore 未接线时跳过 (phase-3 测试挂载兼容)。
   */
  private async maybeRunCleanup(): Promise<void> {
    if (!this.deps.runStateStore) {
      return;
    }
    const nowMs = this.now().getTime();
    if (nowMs - this.lastCleanupAt < this.config.cleanupIntervalMs) {
      return;
    }
    this.lastCleanupAt = nowMs;
    const result = await runLoopStorageCleanup({
      runLedgerStore: this.deps.runLedgerStore,
      learningEventStore: this.deps.learningEventStore,
      runStateStore: this.deps.runStateStore,
      now: this.now,
    });
    if (
      result.ledgersCompressed > 0 ||
      result.artifactFilesDeleted > 0 ||
      result.eventsTruncated > 0
    ) {
      console.log(
        `[LearningWorker] storage cleanup: ${result.ledgersCompressed} ledgers compressed, ${result.artifactFilesDeleted} artifact files deleted, ${result.eventsTruncated} events truncated`,
      );
    }
    await this.pruneWorktrees();
  }

  /**
   * 04 容量与清理: 顺带清理超期 run worktree (worktree.ts 此前只有开机
   * 一次性调用, 这里补上周期路径)。
   *
   * 口径 (钉死, 与 spec 04 对齐):
   * - run 态保护: state ∈ {active, retry, paused, needs_human} 的 run
   *   恢复依赖 worktree, 超龄也保留 (budget_limited 不在其列 —— 该态的
   *   恢复路径是预算重置后开新 run, 见 control-plane 状态机);
   * - maxAgeDays: 全局调用一次, 取所有 card 声明的
   *   workspace.cleanup_rule.max_age_days 中的最小值 —— 满足最严格那
   *   张卡的清理要求, 其余卡的声明值只会更大 (更晚清理), 不会被提前
   *   误清; per-loop 分别清理留作后续刀。无 card 声明时回退默认 7 天。
   *
   * 失败隔离: 清理异常只 warn, 不影响 tick 主流程 (git 调用比账本清理
   * 更易受环境影响, 单独兜一层)。
   */
  private async pruneWorktrees(): Promise<void> {
    try {
      const protectedRunIds = new Set<string>();
      const states = (await this.deps.runStateStore?.list()) ?? [];
      for (const { state: record } of states) {
        if (WORKTREE_PROTECTED_STATES.has(record.state)) {
          protectedRunIds.add(record.run_id);
        }
      }
      let maxAgeDays: number | undefined;
      for (const stored of this.deps.loopCardStore?.listLoops() ?? []) {
        const declared = stored.card.loop.workspace.cleanup_rule?.max_age_days;
        if (declared !== undefined) {
          maxAgeDays = Math.min(maxAgeDays ?? declared, declared);
        }
      }
      const pruned = await pruneStaleWorktrees({
        dataDir: this.deps.dataDir,
        maxAgeDays,
        protectedRunIds,
      });
      if (pruned > 0) {
        console.log(`[LearningWorker] worktree cleanup: ${pruned} pruned`);
      }
    } catch (error) {
      console.warn(
        "[LearningWorker] worktree cleanup failed (isolated):",
        error,
      );
    }
  }

  /**
   * golden tasks (基准与回归.md: "canary 失败时应保留失败样本并进入
   * benchmark"): 每个 open 失败模式衍生一条可复跑的 command case 进
   * eval 集 —— workspace 取受影响 loop 的 card, 命令取 card 钉死的验
   * 证命令 (static 优先, 无钉死命令的模式无法确定性复跑, 跳过)。
   * expect 为 "fail" 如实记录当前失败; 修复使命令转绿后该 case 开始
   * 不符合预期 (套件变红), 由人工把 expect 翻为 "pass" 完成基线更替
   * —— 只增不改, 已存在的 case (含翻转过的) 不动。
   */
  private async syncGoldenCases(): Promise<void> {
    const { loopCardStore, evalRunner } = this.deps;
    if (!loopCardStore || !evalRunner) {
      return;
    }
    const cases: EvalCase[] = [];
    for (const pattern of this.deps.failurePatternStore.list()) {
      if (pattern.status !== "open") {
        continue;
      }
      const loopId = pattern.affected_loop_specs[0];
      if (!loopId) {
        continue;
      }
      const card = loopCardStore.getLoop(loopId)?.card;
      const workspace = card?.loop.workspace.path;
      if (!card || !workspace) {
        continue;
      }
      const pinned =
        card.loop.verification.commands?.static?.[0] ??
        card.loop.verification.commands?.runtime?.[0];
      if (!pinned) {
        continue;
      }
      const [command, ...args] = pinned.split(/\s+/).filter(Boolean);
      if (!command) {
        continue;
      }
      cases.push({
        case_id: `golden-${pattern.pattern_id}`,
        category: pattern.type,
        loop_id: loopId,
        workspace,
        kind: "command",
        command,
        args,
        expect: "fail",
        description: `golden task from failure pattern ${pattern.pattern_id} (${pattern.summary}); 修复使命令转绿后把 expect 翻为 "pass" 完成基线更替`,
      });
    }
    const added = await evalRunner.upsertGoldenCases(cases);
    if (added > 0) {
      console.log(
        `[LearningWorker] golden tasks: ${added} case(s) added to eval suite`,
      );
    }
  }

  /**
   * Consume one learning_event: events without failure_tags carry no
   * failure signal (e.g. complete runs) and never enter the pattern layer.
   * Evidence text for the fingerprint comes from the decision ledger reason
   * (优先带重叠 failure_tags 的决策条目), then the judgment report's
   * unresolved_risks, then the event decision as a stable fallback.
   */
  private async processEvent(event: LearningEvent): Promise<void> {
    if (event.failure_tags.length === 0) {
      return;
    }
    const evidenceText = await this.collectEvidenceText(event);
    for (const tag of event.failure_tags) {
      await this.aggregate(
        tag,
        buildSignature(tag, evidenceText),
        evidenceText,
        {
          runId: event.run_id,
          loopId: event.loop_id,
          seenAt: event.created_at,
        },
      );
    }
  }

  /** 读账本证据 (只读 runs/ + artifacts/), 容错: 读不到就降级. */
  private async collectEvidenceText(event: LearningEvent): Promise<string> {
    try {
      const decisions = await this.deps.runLedgerStore.readDecisionEntries(
        event.run_id,
      );
      const tagged = decisions.filter((entry) =>
        entry.failure_tags?.some((tag) => event.failure_tags.includes(tag)),
      );
      const reason = tagged[0]?.reason ?? decisions[0]?.reason;
      if (reason) {
        return reason;
      }
    } catch (error) {
      console.warn(
        `[LearningWorker] failed to read decision ledger for ${event.run_id}; falling back:`,
        error,
      );
    }
    const judgmentText = await this.readJudgmentText(event.judgment_ref);
    return judgmentText ?? event.decision;
  }

  /** judgment_ref 是 artifact://<run_id>/<file>; 读不出/解析失败返回 undefined. */
  private async readJudgmentText(
    judgmentRef: string,
  ): Promise<string | undefined> {
    const match = /^artifact:\/\/([^/]+)\/(.+)$/.exec(judgmentRef);
    if (!match) {
      return undefined;
    }
    const runId = match[1] as string;
    const file = match[2] as string;
    try {
      const content = await this.deps.runLedgerStore.readArtifact(runId, file);
      if (!content) {
        return undefined;
      }
      const parsed = JudgmentReportSchema.safeParse(JSON.parse(content));
      if (!parsed.success || parsed.data.unresolved_risks.length === 0) {
        return undefined;
      }
      return parsed.data.unresolved_risks.join("; ");
    } catch {
      return undefined;
    }
  }

  /**
   * 确定性预聚合: 同签名按 run 去重计数. 未达阈值进内存桶; 达阈值
   * (>= patternMinOccurrences 且跨 >= minDistinctRuns 个 run) 才
   * 创建/更新 failure_pattern (单次失败不进模式层).
   */
  private async aggregate(
    tag: FailureTag,
    signature: string,
    sampleText: string,
    occurrence: { runId: string; loopId: string; seenAt: string },
  ): Promise<void> {
    const patternId = patternIdFor(signature);
    const existing = this.deps.failurePatternStore.get(patternId);
    if (existing?.evidence_runs.includes(occurrence.runId)) {
      // 同一 run 的同一签名只计一次发作 (幂等: 重放安全)
      return;
    }
    const bucket = this.pending.get(patternId);
    const runs = new Set(existing?.evidence_runs ?? bucket?.runs ?? []);
    runs.add(occurrence.runId);
    const loops = new Set(existing?.affected_loop_specs ?? bucket?.loops ?? []);
    loops.add(occurrence.loopId);
    const firstSeenAt =
      existing?.first_seen_at ?? bucket?.firstSeenAt ?? occurrence.seenAt;

    if (
      !existing &&
      (runs.size < this.config.patternMinOccurrences ||
        runs.size < this.config.minDistinctRuns)
    ) {
      this.pending.set(patternId, {
        tag,
        signature,
        runs,
        loops,
        firstSeenAt,
        sampleText,
      });
      return;
    }
    this.pending.delete(patternId);

    const occurrenceCount = existing
      ? existing.occurrence_count + 1
      : runs.size;
    const summary = existing
      ? existing.summary
      : `反复出现 ${tag}: ${sampleText.slice(0, 80)}`;
    const proposalReady = occurrenceCount >= this.config.proposalMinOccurrences;
    const pattern: FailurePattern = {
      pattern_id: patternId,
      type: tag,
      summary,
      signature,
      occurrence_count: occurrenceCount,
      first_seen_at: firstSeenAt,
      last_seen_at: occurrence.seenAt,
      evidence_runs: [...runs],
      affected_loop_specs: [...loops],
      suggested_action: proposalReady ? "proposal_required" : "monitor",
      status: existing?.status ?? "open",
    };
    // upsert 失败 (校验/落盘) 向上抛, 由 tick 的按事件 catch 记为毒事件
    await this.deps.failurePatternStore.upsert(pattern);
  }

  /**
   * 提案生成 + 去重: open 且达到提案阈值的 pattern → ImprovementProposal
   * (模板化文字, 不调 LLM). proposal id 由 pattern id 确定性派生, 已存在
   * (任意状态, 含已拒绝) 即跳过 —— 不重复新建, 也不覆盖 history.
   */
  private async generateProposals(): Promise<void> {
    for (const pattern of this.deps.failurePatternStore.list()) {
      if (
        pattern.status !== "open" ||
        pattern.occurrence_count < this.config.proposalMinOccurrences
      ) {
        continue;
      }
      const proposalId = proposalIdFor(pattern.pattern_id);
      if (this.deps.proposalStore.get(proposalId)) {
        // 去重: 同 pattern 已有提案 (任意状态, 含已拒绝/已回滚) 即跳过 —
        // 不重复新建, 也不覆盖已有 history; schema 无计数字段可更新.
        continue;
      }
      await this.deps.proposalStore.create(
        this.buildProposal(proposalId, pattern),
      );
    }
  }

  /** 模板化提案 (归因 → 类型查 ATTRIBUTION_TO_PROPOSAL 映射表).
   *
   *  payload 生成口径 (05 阶段 3 验收 5: 自动路径的提案走完管线要对装配
   *  有真实影响) —— 只给有真实消费者的槽位生成机器可读内容:
   *  - memory_packet_template_proposal → memory_packet_template (装配层
   *    注入 prompt, proposal-effects.ts → runtime-input.ts, 真消费者);
   *  - runtime_blackbox_error → runtime_adapter_proposal 带
   *    adapter_policy.timeout_seconds (run-service 轮次超时, 真消费者;
   *    模板值是保守起点, 发布前经管线 + 人工闸门);
   *  - tool_error 的 runtime_adapter_proposal 不带 payload: 工具配置因
   *    案例而异, 无法诚实模板化;
   *  - policy_profile_proposal 不带 payload: 策略档名不能由 worker 安全
   *    杜撰 (不存在的档名会让 resolvePolicyProfile 落空), 由人工在创建/
   *    批准路径补 payload (POST /api/proposals)。
   */
  private buildProposal(
    proposalId: string,
    pattern: FailurePattern,
  ): ImprovementProposal {
    const mapping = ATTRIBUTION_TO_PROPOSAL[pattern.type];
    const loopScope = pattern.affected_loop_specs.join(", ") || "<unknown>";
    const target = pattern.affected_loop_specs[0]
      ? `${pattern.affected_loop_specs[0]}.${mapping.targetHint}`
      : mapping.targetHint;
    const payload =
      mapping.type === "memory_packet_template_proposal"
        ? {
            memory_packet_template: `Known recurring failure pattern (${pattern.pattern_id}, type=${pattern.type}, seen ${pattern.occurrence_count}x): ${pattern.summary} (affected loops: ${loopScope}). Adjust your approach to avoid this failure mode.`,
          }
        : pattern.type === "runtime_blackbox_error"
          ? {
              // 反复 runtime 黑盒失败 (超时类) → 给轮次一个显式超时下限,
              // 由管线验证、人工批准后生效 (10min 保守起点)
              adapter_policy: { timeout_seconds: 600 },
            }
          : undefined;
    return {
      proposal_id: proposalId,
      type: mapping.type,
      source_patterns: [pattern.pattern_id],
      summary:
        `失败模式 ${pattern.pattern_id} (${pattern.type}) 已出现 ` +
        `${pattern.occurrence_count} 次, 涉及 ${pattern.evidence_runs.length} 个 run / ` +
        `${pattern.affected_loop_specs.length} 个 loop (${loopScope}): ` +
        `${pattern.summary}。建议检查并调整 ${target}。`,
      target,
      expected_effect:
        `减少同类 ${pattern.type} 复发 (当前 ${pattern.occurrence_count} 次, ` +
        `首见 ${pattern.first_seen_at}, 最近 ${pattern.last_seen_at})`,
      risk: mapping.risk,
      validation_plan:
        `shadow 档复跑受影响 loop (${loopScope}) 的历史失败样本, ` +
        `确认 ${pattern.type} 不再复发后进入 regression/canary`,
      status: "draft",
      created_by: "worker",
      ...(payload ? { payload } : {}),
      created_at: this.now().toISOString(),
    };
  }
}
