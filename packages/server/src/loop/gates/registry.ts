import type { LoopCard } from "@yep-anywhere/shared";

/** Dependencies deliberately stay opaque to the registry; each gate owns its required services. */
export interface GateDeps {
  [key: string]: unknown;
}

export interface GateContext {
  loopId: string;
  runId: string;
  card: LoopCard;
  /**
   * 本 run 是否带着既有 relation 的维护回合。true 时发布类 gate
   * （pr_publish / issue_proposal）必须跳过——与重构前 turn-loop 的
   * `!ctx.relation` 守卫一致。
   */
  hasRelation: boolean;
  deps: GateDeps;
}

export interface GateDefinition {
  readonly kind: string;
  readonly exclusiveGroup?: string;
  enabledFor(card: LoopCard): boolean;
  promptLines?(): string[];
  onRunCompleted(ctx: GateContext, finalText: string): Promise<boolean>;
}

export class GateRegistry {
  private readonly definitions: GateDefinition[] = [];

  register(definition: GateDefinition): void {
    if (this.definitions.some((item) => item.kind === definition.kind)) {
      throw new Error(`Gate already registered: ${definition.kind}`);
    }
    this.definitions.push(definition);
  }

  forCard(card: LoopCard): GateDefinition[] {
    return this.definitions.filter((definition) => definition.enabledFor(card));
  }

  freeze(): void {
    Object.freeze(this.definitions);
  }
}
