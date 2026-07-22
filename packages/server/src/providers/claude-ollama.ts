import { claudeOllamaProvider } from "../sdk/providers/claude-ollama.js";
import type { AgentProvider } from "../sdk/providers/types.js";
import type { ModelInfoService } from "../services/ModelInfoService.js";
import type { ISessionReader } from "../sessions/types.js";
import type { LoadedSession } from "../sessions/types.js";
import type { Project } from "../supervisor/types.js";
import type { Session } from "../supervisor/types.js";
import type { FileChangeEvent } from "../watcher/EventBus.js";
import type { IProviderAdapter } from "./adapter.js";
import { ClaudeProviderDescriptor } from "./claude.js";
import type { ProviderDescriptor, ProviderScanner } from "./descriptor.js";

/**
 * Claude + Ollama provider descriptor.
 *
 * Session format, scanning, and normalization are identical to Claude,
 * but the agent provider routes to an Ollama backend instead of Anthropic.
 */
export class ClaudeOllamaProviderDescriptor
  implements ProviderDescriptor, IProviderAdapter
{
  readonly names = ["claude-ollama"];
  readonly group = "claude-ollama";

  private delegate: ClaudeProviderDescriptor;

  constructor(modelInfoService?: ModelInfoService) {
    this.delegate = new ClaudeProviderDescriptor(modelInfoService);
  }

  createReader(project: Project): ISessionReader {
    return this.delegate.createReader(project);
  }

  createExtraReader(_projectPath: string): ISessionReader | null {
    return this.delegate.createExtraReader();
  }

  getSessionDir(): string {
    return this.delegate.getSessionDir();
  }

  createScanner(_options: { sessionsDir?: string }): ProviderScanner | null {
    return this.delegate.createScanner();
  }

  getWatchConfig(): { periodicRescanMs: number } {
    return this.delegate.getWatchConfig();
  }

  parseFileType(relativePath: string): import("./descriptor.js").FileType {
    return this.delegate.parseFileType(relativePath);
  }

  get capabilities() {
    return this.delegate.capabilities;
  }

  extractSessionFromFileChange(
    event: FileChangeEvent,
    deps: { projectsDir: string },
  ): { sessionId: string; sessionDir: string } | null {
    return this.delegate.extractSessionFromFileChange?.(event, deps) ?? null;
  }

  getSessionFileCandidates(project: Project, sessionId: string): string[] {
    return this.delegate.getSessionFileCandidates?.(project, sessionId) ?? [];
  }

  getSessionFilePattern(): RegExp {
    return this.delegate.getSessionFilePattern();
  }

  extractSessionIdFromPath(relativePath: string): string | null {
    return this.delegate.extractSessionIdFromPath?.(relativePath) ?? null;
  }

  normalizeSession(loaded: LoadedSession): Session {
    return this.delegate.normalizeSession(loaded);
  }

  getStaleInTurnThresholdMs(): number {
    return this.delegate.getStaleInTurnThresholdMs();
  }

  getDenyFeedbackBehavior(): "queue-followup" | "silent" {
    return this.delegate.getDenyFeedbackBehavior();
  }

  getAgentProvider(): AgentProvider | null {
    return claudeOllamaProvider;
  }

  getScanner(): ProviderScanner | null {
    return this.delegate.getScanner();
  }
}
