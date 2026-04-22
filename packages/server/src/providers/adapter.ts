import type { AgentProvider } from "../sdk/providers/types.js";
import type { LoadedSession } from "../sessions/types.js";
import type { Session } from "../supervisor/types.js";
import type { ProviderDescriptor } from "./descriptor.js";

export interface IProviderAdapter extends ProviderDescriptor {
  /** Normalize a loaded session into generic Session format */
  normalizeSession(loaded: LoadedSession): Session;

  /** Stale-in-turn threshold in milliseconds for this provider */
  getStaleInTurnThresholdMs(): number;

  /** How to handle deny feedback: queue follow-up message or stay silent */
  getDenyFeedbackBehavior(): "queue-followup" | "silent";

  /** Get the AgentProvider instance for this descriptor (null if not applicable) */
  getAgentProvider(): AgentProvider | null;

  /** Get the scanner instance for cache invalidation (null if not applicable) */
  getScanner(): { invalidateCache(): void } | null;
}
