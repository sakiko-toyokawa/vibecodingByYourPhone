/**
 * RelationLifecycleService is the only writer for relation state
 * transitions. Producers send commands (transition / feedback / publish)
 * and the service persists, logs, and emits relation events.
 */

import type { IEventBus } from "../../watcher/index.js";
import { RELATION_MAX_REPAIRS, RELATION_TRIGGER_TYPES } from "./constants.js";
import { extractPrPublishPayload, readGitIdentity } from "./pr-publish.js";
import {
  type RelationRecord,
  type RelationState,
  type RelationStore,
  appendRelationStateLog,
} from "./relation-store.js";

export { RELATION_MAX_REPAIRS, RELATION_TRIGGER_TYPES };

export interface RelationLifecycleDeps {
  relationStore: RelationStore;
  eventBus?: IEventBus;
}

export interface RelationLogInput {
  event: string;
  message: string;
}

export interface RelationFeedbackInput {
  /** Primary event type, using the actual wake vocabulary. */
  eventType: string;
  cursor?: Partial<RelationRecord["last_processed"]>;
  incrementFeedbackCount?: boolean;
  log?: RelationLogInput;
}

export interface RelationFeedbackResult {
  relation: RelationRecord | null;
  repairLimitReached: boolean;
}

export class RelationLifecycleService {
  private readonly deps: RelationLifecycleDeps;

  constructor(deps: RelationLifecycleDeps) {
    this.deps = deps;
  }

  /** Register or update a relation without inventing a state transition. */
  async upsert(
    relation: RelationRecord,
    log?: RelationLogInput,
  ): Promise<RelationRecord> {
    const previous = this.deps.relationStore.findById(relation.relation_id);
    const merged: RelationRecord = {
      ...(previous ?? {}),
      ...relation,
      created_at: previous?.created_at ?? relation.created_at,
      updated_at: new Date().toISOString(),
    };
    if (log) {
      merged.state_logs = appendRelationStateLog(
        merged,
        log.event,
        log.message,
        merged.updated_at,
      );
    }
    const saved = await this.deps.relationStore.upsert(merged);
    this.emitStateChanged(saved, previous?.state ?? null, log);
    return saved;
  }

  /** Persist one relation transition and broadcast it. */
  async transition(
    relationId: string,
    toState: RelationState,
    patch: Partial<RelationRecord> = {},
    log?: RelationLogInput,
  ): Promise<RelationRecord | null> {
    const current = this.deps.relationStore.findById(relationId);
    if (!current) {
      return null;
    }
    const merged: RelationRecord = {
      ...current,
      ...patch,
      state: toState,
      updated_at: new Date().toISOString(),
    };
    if (log) {
      merged.state_logs = appendRelationStateLog(
        merged,
        log.event,
        log.message,
        merged.updated_at,
      );
    }
    const saved = await this.deps.relationStore.updateState(
      relationId,
      toState,
      merged,
    );
    if (!saved) {
      return null;
    }
    this.emitStateChanged(saved, current.state, log);
    return saved;
  }

  /**
   * Handle external feedback. Repair limit enforcement lives here, so
   * poller and webhook producers do not duplicate the policy.
   */
  async receiveFeedback(
    relationId: string,
    input: RelationFeedbackInput,
  ): Promise<RelationFeedbackResult> {
    const current = this.deps.relationStore.findById(relationId);
    if (!current) {
      return { relation: null, repairLimitReached: false };
    }
    const nextRepairCount = current.repair_count + 1;
    const patch: Partial<RelationRecord> = {
      last_processed: {
        ...current.last_processed,
        ...(input.cursor ?? {}),
      },
    };
    if (input.incrementFeedbackCount) {
      patch.feedback_count = current.feedback_count + 1;
    }

    let toState: RelationState;
    if (nextRepairCount > RELATION_MAX_REPAIRS) {
      toState = "needs_human";
      patch.needs_human_reason =
        "repeated relation feedback exceeded auto-repair limit";
    } else {
      toState = "fixing";
      patch.repair_count = nextRepairCount;
    }

    const relation = await this.transition(
      relationId,
      toState,
      patch,
      input.log,
    );
    const repairLimitReached = nextRepairCount > RELATION_MAX_REPAIRS;
    this.deps.eventBus?.emit({
      type: "feedback-received",
      relation_id: relationId,
      loop_id: current.loop_id,
      event_type: input.eventType,
      repair_count: nextRepairCount,
      repair_limit_reached: repairLimitReached,
      timestamp: new Date().toISOString(),
    });
    return { relation, repairLimitReached };
  }

  /**
   * Register a PR-publish handoff produced by a github_prompt run. The
   * relation is parked in pr_pending_approval for the human approval route.
   */
  async registerGithubPrPublish(
    loopId: string,
    runId: string,
    finalText: string,
  ): Promise<RelationRecord | null> {
    const pendingPublish = extractPrPublishPayload(finalText);
    if (!pendingPublish) {
      return null;
    }
    const now = new Date().toISOString();
    const gitIdentity = await readGitIdentity(pendingPublish.cwd);
    const existing = this.deps.relationStore
      .list()
      .find(
        (relation) =>
          relation.loop_id === loopId &&
          relation.subject.type === "github_pr" &&
          relation.subject.repository === pendingPublish.repository &&
          relation.subject.branch === pendingPublish.branch,
      );
    if (existing && existing.state !== "pr_pending_approval") {
      return null;
    }
    const relationId = existing?.relation_id ?? `rel-${loopId}-${runId}`;
    const subject =
      existing?.subject.type === "github_pr"
        ? {
            ...existing.subject,
            repository: pendingPublish.repository,
            branch: pendingPublish.branch,
          }
        : {
            type: "github_pr" as const,
            repository: pendingPublish.repository,
            branch: pendingPublish.branch,
          };
    return this.upsert(
      {
        ...(existing ?? {}),
        relation_id: relationId,
        loop_id: loopId,
        subject,
        state: "pr_pending_approval",
        last_processed: existing?.last_processed ?? {},
        feedback_count: existing?.feedback_count ?? 0,
        repair_count: existing?.repair_count ?? 0,
        pending_publish: {
          ...pendingPublish,
          ...(gitIdentity
            ? {
                author_name: gitIdentity.name,
                author_email: gitIdentity.email,
                identity_source: "git_config",
              }
            : {}),
          run_id: runId,
          created_at: now,
        },
        created_at: existing?.created_at ?? now,
        updated_at: now,
      },
      {
        event: "pr_pending_approval",
        message: `run ${runId} prepared PR publish for ${pendingPublish.repository}:${pendingPublish.branch}`,
      },
    );
  }

  private emitStateChanged(
    relation: RelationRecord,
    fromState: RelationState | null,
    log?: RelationLogInput,
  ): void {
    this.deps.eventBus?.emit({
      type: "relation-state-changed",
      relation_id: relation.relation_id,
      loop_id: relation.loop_id,
      from_state: fromState,
      to_state: relation.state,
      event: log?.event,
      message: log?.message,
      relation,
      timestamp: relation.updated_at,
    });
  }
}
