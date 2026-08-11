import * as fs from "node:fs/promises";
import * as path from "node:path";

export const RELATION_STATES = [
  "pr_pending_approval",
  "awaiting_feedback",
  "fixing",
  "merged",
  "closed",
  "needs_human",
] as const;

export type RelationState = (typeof RELATION_STATES)[number];

export interface GithubRelationSubject {
  type: "github_pr";
  repository: string;
  issue_number?: number;
  pr_number?: number;
  branch: string;
  fork_owner?: string;
  base_sha?: string;
}

export interface RelationRecord {
  relation_id: string;
  loop_id: string;
  subject: GithubRelationSubject;
  state: RelationState;
  last_processed: {
    comment_id?: number;
    review_id?: number;
    commit_sha?: string;
  };
  feedback_count: number;
  repair_count: number;
  needs_human_reason?: string;
  created_at: string;
  updated_at: string;
}

interface RelationStoreFile {
  version: 1;
  relations: Record<string, RelationRecord>;
}

export interface RelationStoreOptions {
  dataDir?: string;
}

function defaultDataDir(): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".yep-anywhere",
  );
}

export class RelationStore {
  private readonly filePath: string;
  private state: RelationStoreFile = { version: 1, relations: {} };
  private initialized = false;

  constructor(options: RelationStoreOptions = {}) {
    this.filePath = path.join(
      options.dataDir ?? defaultDataDir(),
      "loops",
      "relations",
      "relations.json",
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as RelationStoreFile;
      this.state = {
        version: 1,
        relations: parsed.relations ?? {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[RelationStore] Failed to load relations:", error);
      }
    }
    this.initialized = true;
  }

  async upsert(relation: RelationRecord): Promise<RelationRecord> {
    this.ensureInitialized();
    const existing = this.state.relations[relation.relation_id];
    const now = new Date().toISOString();
    const record: RelationRecord = {
      ...existing,
      ...relation,
      created_at: existing?.created_at ?? relation.created_at ?? now,
      updated_at: now,
    };
    this.state.relations[record.relation_id] = record;
    await this.save();
    return record;
  }

  findById(relationId: string): RelationRecord | null {
    this.ensureInitialized();
    return this.state.relations[relationId] ?? null;
  }

  findByGitHubPr(repository: string, prNumber: number): RelationRecord | null {
    this.ensureInitialized();
    return (
      Object.values(this.state.relations).find(
        (relation) =>
          relation.subject.type === "github_pr" &&
          relation.subject.repository === repository &&
          relation.subject.pr_number === prNumber,
      ) ?? null
    );
  }

  list(): RelationRecord[] {
    this.ensureInitialized();
    return Object.values(this.state.relations).sort((a, b) =>
      b.updated_at.localeCompare(a.updated_at),
    );
  }

  async updateState(
    relationId: string,
    state: RelationState,
    patch?: Partial<RelationRecord>,
  ): Promise<RelationRecord | null> {
    const existing = this.findById(relationId);
    if (!existing) {
      return null;
    }
    return this.upsert({ ...existing, ...patch, state });
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(
      tmpPath,
      `${JSON.stringify(this.state, null, 2)}\n`,
      "utf-8",
    );
    await fs.rename(tmpPath, this.filePath);
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "RelationStore not initialized. Call initialize() first.",
      );
    }
  }
}
