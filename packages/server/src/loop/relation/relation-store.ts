import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MaintenanceTargetStore } from "../maintenance/maintenance-target-store.js";
import type {
  MaintenanceTarget,
  MaintenanceTargetState,
} from "../maintenance/types.js";

export const RELATION_STATES = [
  "pr_pending_approval",
  "awaiting_feedback",
  "awaiting_review",
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
    /** Pull request review comments (pulls/{n}/comments). */
    comment_id?: number;
    review_id?: number;
    /** Issue comments on the PR conversation (issues/{n}/comments). */
    issue_comment_id?: number;
    commit_sha?: string;
    ci_failure_sha?: string;
  };
  state_logs?: RelationStateLogEntry[];
  feedback_count: number;
  repair_count: number;
  pending_publish?: {
    repository: string;
    branch: string;
    title: string;
    body: string;
    cwd: string;
    author_name?: string;
    author_email?: string;
    identity_source?: string;
    run_id?: string;
    created_at?: string;
  };
  needs_human_reason?: string;
  created_at: string;
  updated_at: string;
}

export interface RelationStateLogEntry {
  at: string;
  event: string;
  message: string;
}

export function appendRelationStateLog(
  relation: RelationRecord,
  event: string,
  message: string,
  at = new Date().toISOString(),
): RelationStateLogEntry[] {
  return [...(relation.state_logs ?? []), { at, event, message }].slice(-100);
}

interface LegacyRelationFile {
  version: 1;
  relations: Record<string, RelationRecord>;
}

export interface RelationStoreOptions {
  dataDir?: string;
  maintenanceTargetStore?: MaintenanceTargetStore;
}

function defaultDataDir(): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".yep-anywhere",
  );
}

function relationStateToTargetState(
  state: RelationState,
): MaintenanceTargetState {
  switch (state) {
    case "pr_pending_approval":
      return "pending_approval";
    case "awaiting_review":
      return "awaiting_review";
    case "awaiting_feedback":
      return "awaiting_feedback";
    case "fixing":
      return "fixing";
    case "needs_human":
      return "needs_human";
    case "merged":
    case "closed":
      return "done";
  }
}

function targetStateToRelationState(
  state: MaintenanceTargetState,
  fallback?: unknown,
): RelationState {
  switch (state) {
    case "pending_approval":
      return "pr_pending_approval";
    case "awaiting_review":
      return "awaiting_review";
    case "awaiting_feedback":
      return "awaiting_feedback";
    case "fixing":
      return "fixing";
    case "needs_human":
      return "needs_human";
    case "done":
      return fallback === "merged" ? "merged" : "closed";
    default:
      return "awaiting_feedback";
  }
}

function relationToTarget(relation: RelationRecord): MaintenanceTarget {
  const subjectId = relation.subject.pr_number
    ? `${relation.subject.repository}#${relation.subject.pr_number}`
    : `${relation.subject.repository}:${relation.subject.branch}`;
  return {
    target_id: relation.relation_id,
    loop_id: relation.loop_id,
    target_type: "github_pr",
    external_ref: {
      source: "github",
      subject_id: subjectId,
    },
    state: relationStateToTargetState(relation.state),
    feedback_cursor: relation.last_processed,
    feedback_count: relation.feedback_count,
    repair_count: relation.repair_count,
    wake_policy: {
      trigger_types: ["github_comment", "github_review"],
      max_repairs: 3,
    },
    context_payload: {
      target: relation.subject,
    },
    adapter_data: {
      relation_id: relation.relation_id,
      relation_state: relation.state,
      repository: relation.subject.repository,
      pr_number: relation.subject.pr_number,
      issue_number: relation.subject.issue_number,
      branch: relation.subject.branch,
      fork_owner: relation.subject.fork_owner,
      base_sha: relation.subject.base_sha,
      last_processed: relation.last_processed,
      state_logs: relation.state_logs,
      pending_publish: relation.pending_publish,
      needs_human_reason: relation.needs_human_reason,
    },
    created_at: relation.created_at,
    updated_at: relation.updated_at,
  };
}

function targetToRelation(target: MaintenanceTarget): RelationRecord | null {
  if (target.target_type !== "github_pr") {
    return null;
  }
  const adapter = target.adapter_data ?? {};
  const repository =
    typeof adapter.repository === "string" ? adapter.repository : "";
  const branch = typeof adapter.branch === "string" ? adapter.branch : "";
  if (!repository || !branch) {
    return null;
  }
  const state = targetStateToRelationState(
    target.state,
    adapter.relation_state,
  );
  const lastProcessed =
    adapter.last_processed && typeof adapter.last_processed === "object"
      ? (adapter.last_processed as RelationRecord["last_processed"])
      : {};
  const stateLogs = Array.isArray(adapter.state_logs)
    ? (adapter.state_logs as RelationStateLogEntry[])
    : undefined;
  return {
    relation_id: target.target_id,
    loop_id: target.loop_id,
    subject: {
      type: "github_pr",
      repository,
      branch,
      ...(typeof adapter.pr_number === "number"
        ? { pr_number: adapter.pr_number }
        : {}),
      ...(typeof adapter.issue_number === "number"
        ? { issue_number: adapter.issue_number }
        : {}),
      ...(typeof adapter.fork_owner === "string"
        ? { fork_owner: adapter.fork_owner }
        : {}),
      ...(typeof adapter.base_sha === "string"
        ? { base_sha: adapter.base_sha }
        : {}),
    },
    state,
    last_processed: lastProcessed,
    ...(stateLogs ? { state_logs: stateLogs } : {}),
    feedback_count: target.feedback_count,
    repair_count: target.repair_count,
    pending_publish:
      adapter.pending_publish && typeof adapter.pending_publish === "object"
        ? (adapter.pending_publish as RelationRecord["pending_publish"])
        : undefined,
    needs_human_reason:
      typeof adapter.needs_human_reason === "string"
        ? adapter.needs_human_reason
        : undefined,
    created_at: target.created_at,
    updated_at: target.updated_at,
  };
}

export class RelationStore {
  private readonly maintenanceTargetStore: MaintenanceTargetStore;
  private readonly legacyFilePath: string;
  private initialized = false;

  constructor(options: RelationStoreOptions = {}) {
    const dataDir = options.dataDir ?? defaultDataDir();
    this.legacyFilePath = path.join(
      dataDir,
      "loops",
      "relations",
      "relations.json",
    );
    this.maintenanceTargetStore =
      options.maintenanceTargetStore ?? new MaintenanceTargetStore({ dataDir });
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.maintenanceTargetStore.initialize();
    await this.importLegacyRelations();
    this.initialized = true;
  }

  async upsert(relation: RelationRecord): Promise<RelationRecord> {
    this.ensureInitialized();
    const target = await this.maintenanceTargetStore.upsert(
      relationToTarget(relation),
    );
    return targetToRelation(target) ?? relation;
  }

  findById(relationId: string): RelationRecord | null {
    this.ensureInitialized();
    const target = this.maintenanceTargetStore.findById(relationId);
    return target ? targetToRelation(target) : null;
  }

  findByGitHubPr(repository: string, prNumber: number): RelationRecord | null {
    this.ensureInitialized();
    const target = this.maintenanceTargetStore
      .list()
      .find(
        (item) =>
          item.target_type === "github_pr" &&
          item.adapter_data?.repository === repository &&
          item.adapter_data?.pr_number === prNumber,
      );
    return target ? targetToRelation(target) : null;
  }

  list(): RelationRecord[] {
    this.ensureInitialized();
    return this.maintenanceTargetStore
      .list()
      .filter((target) => target.target_type === "github_pr")
      .map((target) => targetToRelation(target))
      .filter((relation): relation is RelationRecord => relation !== null)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async updateState(
    relationId: string,
    state: RelationState,
    patch?: Partial<RelationRecord>,
  ): Promise<RelationRecord | null> {
    const current = this.findById(relationId);
    if (!current) {
      return null;
    }
    const merged = { ...current, ...patch, state };
    await this.maintenanceTargetStore.upsert(relationToTarget(merged));
    return this.findById(relationId);
  }

  private async importLegacyRelations(): Promise<void> {
    const existingGithubTargets = this.maintenanceTargetStore
      .list()
      .some((target) => target.target_type === "github_pr");
    if (existingGithubTargets) {
      return;
    }
    let content: string;
    try {
      content = await fs.readFile(this.legacyFilePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[RelationStore] Failed to load legacy relations:", error);
      }
      return;
    }
    try {
      const parsed = JSON.parse(content) as LegacyRelationFile;
      for (const relation of Object.values(parsed.relations ?? {})) {
        await this.maintenanceTargetStore.upsert(relationToTarget(relation));
      }
    } catch (error) {
      console.warn(
        "[RelationStore] Failed to migrate legacy relations:",
        error,
      );
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "RelationStore not initialized. Call initialize() first.",
      );
    }
  }
}
