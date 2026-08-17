import type { LoopCard } from "@yep-anywhere/shared";

export interface WorkspaceResolverContext {
  dataDir: string;
  runId: string;
}

export interface WorkspaceResolver {
  readonly id: string;
  matches(card: LoopCard): boolean;
  resolve(card: LoopCard, context: WorkspaceResolverContext): Promise<{
    card: LoopCard;
    handled: boolean;
  }>;
}

export class WorkspaceResolverRegistry {
  private readonly resolvers: WorkspaceResolver[] = [];
  private frozen = false;

  register(resolver: WorkspaceResolver): void {
    if (this.frozen) throw new Error("Workspace resolver registry is frozen");
    if (this.resolvers.some((item) => item.id === resolver.id)) {
      throw new Error(`Workspace resolver already registered: ${resolver.id}`);
    }
    this.resolvers.push(resolver);
  }

  find(card: LoopCard): WorkspaceResolver | null {
    return this.resolvers.find((resolver) => resolver.matches(card)) ?? null;
  }

  freeze(): void {
    this.frozen = true;
  }
}
