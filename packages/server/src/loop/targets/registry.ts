import type { GitHubClient } from "../../github/index.js";
import type { MaintenanceTargetState } from "../maintenance/types.js";
import type { RelationLifecycleService } from "../relation/lifecycle-service.js";
import type { RelationRecord } from "../relation/relation-store.js";
import type { TriggerQueueStore } from "../state/trigger-queue-store.js";

export interface TargetPollContext {
  lifecycle: RelationLifecycleService;
  triggerQueueStore: TriggerQueueStore;
  drainPendingTriggers?: (loopId?: string) => Promise<void>;
  githubClient?: GitHubClient;
  selfLogin?: string | null;
}

export interface TargetWebhookContext extends TargetPollContext {
  eventId?: string;
  eventType?: string;
  delivery?: string;
  repository?: string;
  subjectNumber?: number;
  action?: string;
  pullRequest?: Record<string, unknown>;
  comment?: Record<string, unknown>;
  review?: Record<string, unknown>;
  sender?: Record<string, unknown>;
}

export interface TargetAdapter {
  readonly targetType: string;
  poll(relation: RelationRecord, ctx: TargetPollContext): Promise<number>;
  handleWebhook(
    relation: RelationRecord,
    payload: Record<string, unknown>,
    ctx: TargetWebhookContext,
  ): Promise<Record<string, unknown>>;
  toTargetState(state: string): MaintenanceTargetState;
  fromTargetState(state: MaintenanceTargetState, fallback?: unknown): string;
}

export class TargetAdapterRegistry {
  private readonly adapters = new Map<string, TargetAdapter>();
  private frozen = false;

  register(adapter: TargetAdapter): void {
    if (this.frozen) {
      throw new Error("Target adapter registry is frozen");
    }
    if (this.adapters.has(adapter.targetType)) {
      throw new Error(
        `Target adapter already registered: ${adapter.targetType}`,
      );
    }
    this.adapters.set(adapter.targetType, adapter);
  }

  get(targetType: string): TargetAdapter | null {
    return this.adapters.get(targetType) ?? null;
  }

  freeze(): void {
    this.frozen = true;
  }
}
