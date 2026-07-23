/**
 * Proposal store — improvement proposals and their release-pipeline state
 * (spec: docs/spec/02-schema契约.md §8.5, 04-存储约定.md learning/ 布局).
 *
 * Layout (04):
 * - `proposals/<proposal_id>.json`: one file per proposal —
 *   `{ version, proposal, history }`. Every status change is appended to
 *   `history` so the pipeline (shadow → regression → canary → publish, and
 *   rollbacks) is auditable end to end.
 * - `proposals/index.json`: a lightweight projection (id, type, status,
 *   target, timestamps) for list views, rewritten on every change.
 *
 * Single-writer convention (04 单写者表): the server-process singleton
 * `proposalStore` serializes every write — the learning worker and the API
 * (approve / publish / rollback) both go through it; a worker running as a
 * separate entry must call the server API instead of touching the files.
 * Writes use temp-file + atomic rename; loads are fault-tolerant (a corrupt
 * proposal file is backed up to `.corrupt-<ts>` and skipped, never crashes
 * the store).
 *
 * Status machine (02 §8.5 statuses, 提案验证与发布.md 管线):
 *   draft     → shadow | rejected
 *   shadow    → canary | rejected | rolled_back
 *   canary    → approved | rejected | rolled_back
 *   approved  → published | rolled_back
 *   published → rolled_back
 * rolled_back / rejected are terminal. The regression pipeline stage is a
 * validation gate between shadow and canary — it is recorded in history via
 * `stage`, it is not a persisted status (02 §8.5 has no regression status).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type ImprovementProposal,
  ImprovementProposalSchema,
  type ProposalCreatedBy,
  type ProposalPipelineStage,
  type ProposalStatus,
} from "@yep-anywhere/shared";

/** proposal_id must stay inside the proposals/ directory. */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export type ProposalStoreErrorCode =
  | "proposal_not_found"
  | "invalid_transition"
  | "invalid_proposal";

export class ProposalStoreError extends Error {
  constructor(
    readonly code: ProposalStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProposalStoreError";
  }
}

/** One auditable status change on the release pipeline. */
export interface ProposalStatusChange {
  from: ProposalStatus;
  to: ProposalStatus;
  /** Pipeline stage this change belongs to, when driven by the pipeline. */
  stage?: ProposalPipelineStage;
  /** Who drove the change (元规则变更仅 human, 阶段 3 验收 4). */
  by: ProposalCreatedBy;
  reason?: string;
  at: string;
}

interface ProposalFile {
  version: number;
  proposal: ImprovementProposal;
  history: ProposalStatusChange[];
}

export interface ProposalIndexEntry {
  proposal_id: string;
  type: ImprovementProposal["type"];
  status: ProposalStatus;
  target: string;
  created_by: ProposalCreatedBy;
  created_at: string;
  updated_at: string;
}

interface ProposalIndex {
  version: number;
  proposals: ProposalIndexEntry[];
}

/** Legal status transitions (see file header). */
const TRANSITIONS: Record<ProposalStatus, readonly ProposalStatus[]> = {
  draft: ["shadow", "rejected"],
  shadow: ["canary", "rejected", "rolled_back"],
  canary: ["approved", "rejected", "rolled_back"],
  approved: ["published", "rolled_back"],
  published: ["rolled_back"],
  rolled_back: [],
  rejected: [],
};

const FILE_VERSION = 1;

export interface ProposalStoreOptions {
  /** Yep data directory (defaults to ~/.yep-anywhere); loops/ lives under it */
  dataDir?: string;
}

export interface TransitionOptions {
  /** Pipeline stage driving this change (recorded in history). */
  stage?: ProposalPipelineStage;
  /** Who drives the change; defaults to worker. */
  by?: ProposalCreatedBy;
  reason?: string;
}

function defaultDataDir(): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".yep-anywhere",
  );
}

export class ProposalStore {
  private readonly proposalsDir: string;
  private readonly indexFile: string;
  /** proposal_id -> loaded file content (in-memory mirror of the files) */
  private proposals = new Map<string, ProposalFile>();
  /** Serializes every write (04: server-process singleton writer) */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: ProposalStoreOptions = {}) {
    this.proposalsDir = path.join(
      options.dataDir ?? defaultDataDir(),
      "loops",
      "learning",
      "proposals",
    );
    this.indexFile = path.join(this.proposalsDir, "index.json");
  }

  /**
   * Load all proposals from disk. Corrupt or schema-invalid files are
   * backed up to `.corrupt-<ts>` and skipped — one bad proposal never
   * blocks the rest of the pipeline.
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.proposalsDir, { recursive: true });
    let files: string[];
    try {
      files = await fs.readdir(this.proposalsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const file of files) {
      if (!file.endsWith(".json") || file === "index.json") {
        continue;
      }
      const filePath = path.join(this.proposalsDir, file);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const parsed = JSON.parse(content) as ProposalFile;
        const proposal = ImprovementProposalSchema.parse(parsed.proposal);
        this.proposals.set(proposal.proposal_id, {
          version: FILE_VERSION,
          proposal,
          history: Array.isArray(parsed.history) ? parsed.history : [],
        });
      } catch (error) {
        console.warn(
          `[ProposalStore] skipping corrupt proposal file ${file}:`,
          error,
        );
        await this.backupCorruptFile(filePath);
      }
    }
  }

  private async backupCorruptFile(filePath: string): Promise<void> {
    try {
      await fs.rename(filePath, `${filePath}.corrupt-${Date.now()}`);
    } catch {
      // Best effort
    }
  }

  /** Get a proposal by id. */
  get(proposalId: string): ImprovementProposal | undefined {
    return this.proposals.get(proposalId)?.proposal;
  }

  /** Get a proposal's auditable status-change history. */
  getHistory(proposalId: string): ProposalStatusChange[] {
    return [...this.require(proposalId).history];
  }

  /** List proposals as index entries (list views; status filter optional). */
  list(status?: ProposalStatus): ProposalIndexEntry[] {
    return [...this.proposals.values()]
      .map(({ proposal, history }) => this.toIndexEntry(proposal, history))
      .filter((entry) => !status || entry.status === status);
  }

  /**
   * Create a proposal in draft status (worker-generated or human-initiated).
   * Overwrites an existing id — callers must check get() first.
   */
  async create(proposal: ImprovementProposal): Promise<ImprovementProposal> {
    this.assertSafeName(proposal.proposal_id);
    const validated = ImprovementProposalSchema.parse(proposal);
    if (validated.status !== "draft") {
      throw new ProposalStoreError(
        "invalid_proposal",
        `new proposals must start in draft (got '${validated.status}'); use transitionStatus to advance`,
      );
    }
    this.proposals.set(validated.proposal_id, {
      version: FILE_VERSION,
      proposal: validated,
      history: [],
    });
    await this.persist(validated.proposal_id);
    return validated;
  }

  /**
   * Advance (or reject) a proposal along the release pipeline. Legality is
   * guarded by the TRANSITIONS table; every change lands in history with
   * stage / by / reason (管线可审计).
   */
  async transitionStatus(
    proposalId: string,
    to: ProposalStatus,
    options: TransitionOptions = {},
  ): Promise<ImprovementProposal> {
    const file = this.require(proposalId);
    const from = file.proposal.status;
    const legal = TRANSITIONS[from] ?? [];
    if (!legal.includes(to)) {
      throw new ProposalStoreError(
        "invalid_transition",
        `proposal '${proposalId}' cannot transition ${from} → ${to} (legal: ${legal.join(", ") || "none — terminal"})`,
      );
    }
    return this.applyChange(file, to, options);
  }

  /**
   * Roll a proposal back (any pipeline stage → rolled_back). Shadow /
   * canary / approved / published can all roll back (05 阶段 3: 任一档不
   * 通过可回滚，全程账本可查).
   */
  async rollback(
    proposalId: string,
    options: TransitionOptions = {},
  ): Promise<ImprovementProposal> {
    return this.transitionStatus(proposalId, "rolled_back", options);
  }

  private applyChange(
    file: ProposalFile,
    to: ProposalStatus,
    options: TransitionOptions,
  ): Promise<ImprovementProposal> {
    const from = file.proposal.status;
    const change: ProposalStatusChange = {
      from,
      to,
      stage: options.stage,
      by: options.by ?? "worker",
      reason: options.reason,
      at: new Date().toISOString(),
    };
    file.history.push(change);
    file.proposal = { ...file.proposal, status: to };
    return this.persist(file.proposal.proposal_id).then(() => file.proposal);
  }

  private require(proposalId: string): ProposalFile {
    const file = this.proposals.get(proposalId);
    if (!file) {
      throw new ProposalStoreError(
        "proposal_not_found",
        `proposal '${proposalId}' not found`,
      );
    }
    return file;
  }

  private toIndexEntry(
    proposal: ImprovementProposal,
    history: ProposalStatusChange[],
  ): ProposalIndexEntry {
    return {
      proposal_id: proposal.proposal_id,
      type: proposal.type,
      status: proposal.status,
      target: proposal.target,
      created_by: proposal.created_by,
      created_at: proposal.created_at,
      updated_at: history[history.length - 1]?.at ?? proposal.created_at,
    };
  }

  /**
   * Write the proposal file + rebuild the index, serialized through the
   * store-wide write chain (single-writer). Temp file + atomic rename.
   */
  private persist(proposalId: string): Promise<void> {
    const next = this.writeChain.then(async () => {
      const file = this.require(proposalId);
      await fs.mkdir(this.proposalsDir, { recursive: true });
      await this.writeAtomic(
        path.join(this.proposalsDir, `${proposalId}.json`),
        JSON.stringify(file, null, 2),
      );
      const index: ProposalIndex = {
        version: FILE_VERSION,
        proposals: [...this.proposals.values()].map((f) =>
          this.toIndexEntry(f.proposal, f.history),
        ),
      };
      await this.writeAtomic(this.indexFile, JSON.stringify(index, null, 2));
    });
    this.writeChain = next.catch((error) => {
      console.error("[ProposalStore] persist failed:", error);
    });
    return next;
  }

  private async writeAtomic(filePath: string, content: string): Promise<void> {
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, content, "utf-8");
    await fs.rename(tmpPath, filePath);
  }

  private assertSafeName(name: string): void {
    if (!SAFE_NAME.test(name)) {
      throw new ProposalStoreError(
        "invalid_proposal",
        `unsafe proposal_id '${name}' (must match ${SAFE_NAME})`,
      );
    }
  }
}
