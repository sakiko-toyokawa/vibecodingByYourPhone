import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { EventBus, SourceChangeEvent } from "./EventBus.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface SourceWatcherOptions {
  /** EventBus to emit events to */
  eventBus: EventBus;
  /** Debounce delay in ms (default: 500) */
  debounceMs?: number;
}

/**
 * Watches server source files for changes when running without tsx watch.
 * Emits source-change events so the UI can notify the user to reload.
 */
export class SourceWatcher {
  private eventBus: EventBus;
  private debounceMs: number;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingFiles: Set<string> = new Set();
  private watchDir: string;

  constructor(options: SourceWatcherOptions) {
    this.eventBus = options.eventBus;
    this.debounceMs = options.debounceMs ?? 500;
    // Watch the src directory relative to this file's location
    this.watchDir = path.resolve(__dirname, "..");
  }

  /**
   * Start watching for source file changes.
   */
  start(): void {
    if (this.watcher) {
      return; // Already watching
    }

    try {
      this.watcher = fs.watch(
        this.watchDir,
        { recursive: true },
        (eventType, filename) => {
          if (filename && this.isSourceFile(filename)) {
            this.handleFileEvent(filename);
          }
        },
      );

      this.watcher.on("error", (error) => {
        console.error("[SourceWatcher] Error:", error);
      });

      console.log(
        `[SourceWatcher] Watching ${this.watchDir} for source changes`,
      );
    } catch (error) {
      console.error("[SourceWatcher] Failed to start:", error);
    }
  }

  /**
   * Stop watching for file changes.
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingFiles.clear();

    console.log("[SourceWatcher] Stopped");
  }

  /**
   * Check if watcher is active.
   */
  get isWatching(): boolean {
    return this.watcher !== null;
  }

  private isSourceFile(filename: string): boolean {
    // Watch TypeScript files but ignore node_modules and dist
    return (
      (filename.endsWith(".ts") || filename.endsWith(".tsx")) &&
      !filename.includes("node_modules") &&
      !filename.includes("dist")
    );
  }

  private handleFileEvent(filename: string): void {
    this.pendingFiles.add(filename);

    // Debounce: batch multiple rapid changes into one event
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.emitEvent();
    }, this.debounceMs);
  }

  private emitEvent(): void {
    if (this.pendingFiles.size === 0) return;

    const files = Array.from(this.pendingFiles);
    this.pendingFiles.clear();
    this.debounceTimer = null;

    const event: SourceChangeEvent = {
      type: "source-change",
      target: "backend",
      files,
      timestamp: new Date().toISOString(),
    };

    console.log(`[SourceWatcher] Source changed: ${files.join(", ")}`);
    this.eventBus.emit(event);
  }
}
