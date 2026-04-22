import type { Process } from "./Process.js";

export interface ProcessPoolOptions {
  /** Maximum concurrent processes. 0 = unlimited */
  maxWorkers: number;
  /** Maximum idle processes to keep alive. 0 = unlimited */
  maxIdleWorkers?: number;
  /** Idle threshold in ms before a process is eligible for preemption */
  idlePreemptThresholdMs: number;
}

/**
 * Manages the lifecycle and capacity of session processes.
 *
 * ProcessPool does not create processes — it only tracks them and enforces
 * capacity limits. Creation is delegated to the caller (Supervisor).
 */
export class ProcessPool {
  private processes = new Map<string, Process>();
  private _maxWorkers: number;
  private _maxIdleWorkers: number;
  private _idlePreemptThresholdMs: number;

  constructor(options: ProcessPoolOptions) {
    this._maxWorkers = options.maxWorkers;
    this._maxIdleWorkers = options.maxIdleWorkers ?? 0;
    this._idlePreemptThresholdMs = options.idlePreemptThresholdMs;
  }

  /** Register a process in the pool */
  register(process: Process): void {
    this.processes.set(process.id, process);
  }

  /** Unregister a process */
  unregister(processId: string): void {
    this.processes.delete(processId);
  }

  /** Get a process by ID */
  get(processId: string): Process | undefined {
    return this.processes.get(processId);
  }

  /** Check if a process is tracked */
  has(processId: string): boolean {
    return this.processes.has(processId);
  }

  /** Get all active processes */
  getAll(): Process[] {
    return Array.from(this.processes.values());
  }

  /** Current active process count */
  get size(): number {
    return this.processes.size;
  }

  /** Maximum concurrent workers */
  get maxWorkers(): number {
    return this._maxWorkers;
  }

  /** Check if pool is at capacity */
  isAtCapacity(): boolean {
    if (this._maxWorkers <= 0) return false;
    return this.processes.size >= this._maxWorkers;
  }

  /**
   * Find a preemptable process (idle longer than threshold).
   * Returns the one that has been idle longest.
   * Does not preempt processes waiting for input.
   */
  findPreemptable(): Process | undefined {
    let oldest: Process | undefined;
    let oldestIdleTime = 0;
    const now = Date.now();

    for (const process of this.processes.values()) {
      if (process.state.type !== "idle") continue;

      const idleMs = now - process.state.since.getTime();
      if (idleMs >= this._idlePreemptThresholdMs && idleMs > oldestIdleTime) {
        oldest = process;
        oldestIdleTime = idleMs;
      }
    }

    return oldest;
  }

  /**
   * Find idle processes that exceed maxIdleWorkers limit.
   * Returns processes sorted by idle time (oldest first).
   */
  findExcessIdleProcesses(): Process[] {
    if (this._maxIdleWorkers <= 0) return [];

    const idleProcesses: { process: Process; idleMs: number }[] = [];
    const now = Date.now();

    for (const process of this.processes.values()) {
      if (process.state.type !== "idle") continue;
      idleProcesses.push({
        process,
        idleMs: now - process.state.since.getTime(),
      });
    }

    if (idleProcesses.length <= this._maxIdleWorkers) return [];

    idleProcesses.sort((a, b) => b.idleMs - a.idleMs);
    return idleProcesses.slice(this._maxIdleWorkers).map((p) => p.process);
  }

  /** Gracefully abort and unregister a process */
  async preempt(process: Process): Promise<void> {
    await process.abort();
    this.unregister(process.id);
  }
}
