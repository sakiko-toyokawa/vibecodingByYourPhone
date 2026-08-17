import type { GitHubClient } from "../../github/index.js";
import {
  createGithubIssueTarget,
  createGithubPrTarget,
} from "../adapters/github/index.js";
import type { TriggerQueueStore } from "../state/trigger-queue-store.js";
import {
  TargetAdapterRegistry,
  type TargetAdapterRegistry as TargetAdapterRegistryType,
} from "../targets/registry.js";
import { RelationLifecycleService } from "./lifecycle-service.js";
import type { RelationStore } from "./relation-store.js";

export interface RelationPollerDeps {
  relationStore: RelationStore;
  relationLifecycle?: RelationLifecycleService;
  githubClient: GitHubClient;
  triggerQueueStore: TriggerQueueStore;
  drainPendingTriggers?: (loopId?: string) => Promise<void>;
  targetAdapterRegistry?: TargetAdapterRegistryType;
}

export class RelationPoller {
  private readonly lifecycle: RelationLifecycleService;
  private readonly targetAdapterRegistry: TargetAdapterRegistryType;
  private timer: NodeJS.Timeout | null = null;
  private selfLoginCache?: string | null;

  constructor(private readonly deps: RelationPollerDeps) {
    this.lifecycle =
      deps.relationLifecycle ??
      new RelationLifecycleService({ relationStore: deps.relationStore });
    this.targetAdapterRegistry =
      deps.targetAdapterRegistry ?? RelationPoller.createDefaultRegistry();
  }

  private static createDefaultRegistry(): TargetAdapterRegistryType {
    const registry = new TargetAdapterRegistry();
    registry.register(createGithubPrTarget());
    registry.register(createGithubIssueTarget());
    registry.freeze();
    return registry;
  }

  private async selfLogin(): Promise<string | null> {
    if (this.selfLoginCache === undefined) {
      try {
        this.selfLoginCache = (
          await this.deps.githubClient.getVerifiedIdentity()
        ).login;
      } catch {
        this.selfLoginCache = null;
      }
    }
    return this.selfLoginCache;
  }

  start(intervalMs = 5 * 60 * 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollOnce().catch((error) => {
        console.error("[RelationPoller] poll failed:", error);
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<number> {
    let events = 0;
    const selfLogin = await this.selfLogin();
    for (const relation of this.deps.relationStore.list()) {
      const adapter = this.targetAdapterRegistry.get(relation.subject.type);
      if (!adapter) {
        console.warn(
          `[RelationPoller] no adapter registered for '${relation.subject.type}'`,
        );
        continue;
      }
      events += await adapter.poll(relation, {
        lifecycle: this.lifecycle,
        triggerQueueStore: this.deps.triggerQueueStore,
        drainPendingTriggers: this.deps.drainPendingTriggers,
        githubClient: this.deps.githubClient,
        selfLogin,
      });
    }
    return events;
  }
}
