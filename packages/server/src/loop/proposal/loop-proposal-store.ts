/**
 * LoopProposalStore — LOOP-PROPOSAL 閘門的提案注册表
 * （loop-self-proposal-gate 计划 P1-3）。
 *
 * 照搬 MaintenanceTargetStore 的 JSON 文件存储模式：版本号、容错加载、
 * 临时文件 + 原子重命名 + 文件锁写回。状态机 pending_approval →
 * approved / rejected（无 repair——提案要么落地要么死掉）。
 *
 * 单写者约定：server 进程的 LoopProposalLifecycleService 是唯一写者；
 * 路由与其他模块只读。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LoopCard } from "@yep-anywhere/shared";
import { withFileLock } from "../../utils/fileLock.js";

export type LoopProposalState = "pending_approval" | "approved" | "rejected";

export interface LoopProposalStateLog {
  event: string;
  message: string;
  at: string;
}

export interface LoopProposalRecord {
  proposal_id: string;
  /** 提案来源 loop（父 loop）。 */
  loop_id: string;
  /** 产出提案块的 run。 */
  run_id: string;
  /** 血缘：与 card.loop.parent_loop_id 一致，冗余置顶便于查询/展示。 */
  parent_loop_id: string;
  /** agent 的提案理由。 */
  reason: string;
  /** 钳制后的提案卡（approve 时原样交给 LoopCardStore 落地）。 */
  card: LoopCard;
  state: LoopProposalState;
  state_logs: LoopProposalStateLog[];
  /** approve 落地后记录创建的 loop id（= card.loop.id）。 */
  created_loop_id?: string;
  /** rejected 的原因（人工拒绝理由 / 配额超限说明）。 */
  rejection_reason?: string;
  created_at: string;
  updated_at: string;
}

interface LoopProposalFile {
  version: 1;
  proposals: Record<string, LoopProposalRecord>;
}

export interface LoopProposalStoreOptions {
  dataDir?: string;
}

function defaultDataDir(): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".yep-anywhere",
  );
}

export function appendLoopProposalStateLog(
  proposal: LoopProposalRecord,
  event: string,
  message: string,
  at: string,
): LoopProposalStateLog[] {
  return [...(proposal.state_logs ?? []), { event, message, at }];
}

export class LoopProposalStore {
  private readonly filePath: string;
  private state: LoopProposalFile = { version: 1, proposals: {} };
  private initialized = false;

  constructor(options: LoopProposalStoreOptions = {}) {
    this.filePath = path.join(
      options.dataDir ?? defaultDataDir(),
      "loops",
      "proposals",
      "proposals.json",
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as LoopProposalFile;
      this.state = {
        version: 1,
        proposals: parsed.proposals ?? {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[LoopProposalStore] Failed to load proposals:", error);
      }
    }
    this.initialized = true;
  }

  findById(proposalId: string): LoopProposalRecord | null {
    this.ensureInitialized();
    return this.state.proposals[proposalId] ?? null;
  }

  list(loopId?: string): LoopProposalRecord[] {
    this.ensureInitialized();
    return Object.values(this.state.proposals)
      .filter((proposal) => !loopId || proposal.loop_id === loopId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async upsert(proposal: LoopProposalRecord): Promise<LoopProposalRecord> {
    this.ensureInitialized();
    const existing = this.state.proposals[proposal.proposal_id];
    const now = new Date().toISOString();
    const record: LoopProposalRecord = {
      ...existing,
      ...proposal,
      created_at: existing?.created_at ?? proposal.created_at ?? now,
      updated_at: now,
    };
    this.state.proposals[record.proposal_id] = record;
    await this.save();
    return record;
  }

  async updateState(
    proposalId: string,
    state: LoopProposalState,
    patch?: Partial<LoopProposalRecord>,
  ): Promise<LoopProposalRecord | null> {
    const existing = this.findById(proposalId);
    if (!existing) {
      return null;
    }
    return this.upsert({ ...existing, ...patch, state });
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, "", { flag: "a" });
    await withFileLock(this.filePath, async () => {
      const tmpPath = `${this.filePath}.tmp`;
      await fs.writeFile(
        tmpPath,
        `${JSON.stringify(this.state, null, 2)}\n`,
        "utf-8",
      );
      await fs.rename(tmpPath, this.filePath);
    });
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "LoopProposalStore not initialized. Call initialize() first.",
      );
    }
  }
}
