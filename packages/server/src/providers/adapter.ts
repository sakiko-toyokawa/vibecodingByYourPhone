import type { UrlProjectId } from "@yep-anywhere/shared";
import type { AgentProvider } from "../sdk/providers/types.js";
import type { LoadedSession } from "../sessions/types.js";
import type { Project } from "../supervisor/types.js";
import type { Session } from "../supervisor/types.js";
import type { FileChangeEvent } from "../watcher/EventBus.js";
import type { ProviderDescriptor, ProviderScanner } from "./descriptor.js";

export interface IProviderAdapter extends ProviderDescriptor {
  /** Normalize a loaded session into generic Session format */
  normalizeSession(loaded: LoadedSession): Session;

  /** Stale-in-turn threshold in milliseconds for this provider */
  getStaleInTurnThresholdMs(): number;

  /** How to handle deny feedback: queue follow-up message or stay silent */
  getDenyFeedbackBehavior(): "queue-followup" | "silent";

  /** Get the AgentProvider instance for this descriptor (null if not applicable) */
  getAgentProvider(): AgentProvider | null;

  /** Get the scanner instance for cache invalidation and session lookup (null if not applicable) */
  getScanner(): ProviderScanner | null;

  /**
   * Extract session identification from a file change event for index invalidation.
   * Return null to fall through to default group-level invalidation.
   */
  extractSessionFromFileChange?(
    event: FileChangeEvent,
    deps: { projectsDir: string },
  ): { sessionId: string; sessionDir: string } | null;

  /**
   * Get candidate file paths for a session. Return null if scanner-based lookup is needed.
   */
  getSessionFileCandidates?(
    project: Project,
    sessionId: string,
  ): string[] | null;

  /** Regex pattern for session files of this provider */
  getSessionFilePattern(): RegExp;

  /**
   * For external session tracking: extract session ID from a file path.
   * Return null if not a session file for this provider.
   */
  extractSessionIdFromPath?(relativePath: string): string | null;

  /**
   * For external session tracking: read project ID from a session file.
   * Return null if the project ID is encoded in the path (standard handling).
   */
  readProjectIdFromFile?(filePath: string): Promise<UrlProjectId | null>;
}
