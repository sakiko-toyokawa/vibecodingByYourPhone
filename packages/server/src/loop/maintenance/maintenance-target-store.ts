import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "../../utils/fileLock.js";
import type { MaintenanceTarget, MaintenanceTargetState } from "./types.js";

interface MaintenanceTargetFile {
  version: 1;
  targets: Record<string, MaintenanceTarget>;
}

export interface MaintenanceTargetStoreOptions {
  dataDir?: string;
}

function defaultDataDir(): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".yep-anywhere",
  );
}

export class MaintenanceTargetStore {
  private readonly filePath: string;
  private state: MaintenanceTargetFile = { version: 1, targets: {} };
  private initialized = false;

  constructor(options: MaintenanceTargetStoreOptions = {}) {
    this.filePath = path.join(
      options.dataDir ?? defaultDataDir(),
      "loops",
      "maintenance",
      "targets.json",
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as MaintenanceTargetFile;
      this.state = {
        version: 1,
        targets: parsed.targets ?? {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[MaintenanceTargetStore] Failed to load targets:", error);
      }
    }
    this.initialized = true;
  }

  findById(targetId: string): MaintenanceTarget | null {
    this.ensureInitialized();
    return this.state.targets[targetId] ?? null;
  }

  findByExternalRef(
    source: string,
    subjectId: string,
  ): MaintenanceTarget | null {
    this.ensureInitialized();
    return (
      Object.values(this.state.targets).find(
        (target) =>
          target.external_ref?.source === source &&
          target.external_ref?.subject_id === subjectId,
      ) ?? null
    );
  }

  list(loopId?: string): MaintenanceTarget[] {
    this.ensureInitialized();
    return Object.values(this.state.targets)
      .filter((target) => !loopId || target.loop_id === loopId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  findByRepository(
    repository: string,
    issueNumber?: number,
  ): MaintenanceTarget[] {
    this.ensureInitialized();
    const normalized = repository.trim().toLowerCase();
    return this.list().filter((target) => {
      if (target.target_type !== "github_pr") {
        return false;
      }
      const adapter = (target.adapter_data ?? {}) as {
        repository?: unknown;
        issue_number?: unknown;
        pr_number?: unknown;
      };
      if (String(adapter.repository ?? "").toLowerCase() !== normalized) {
        return false;
      }
      if (issueNumber === undefined) {
        return true;
      }
      return (
        adapter.issue_number === issueNumber ||
        adapter.pr_number === issueNumber
      );
    });
  }

  async upsert(target: MaintenanceTarget): Promise<MaintenanceTarget> {
    this.ensureInitialized();
    const existing = this.state.targets[target.target_id];
    const now = new Date().toISOString();
    const record: MaintenanceTarget = {
      ...existing,
      ...target,
      created_at: existing?.created_at ?? target.created_at ?? now,
      updated_at: now,
    };
    this.state.targets[record.target_id] = record;
    await this.save();
    return record;
  }

  async updateState(
    targetId: string,
    state: MaintenanceTargetState,
    patch?: Partial<MaintenanceTarget>,
  ): Promise<MaintenanceTarget | null> {
    const existing = this.findById(targetId);
    if (!existing) {
      return null;
    }
    return this.upsert({ ...existing, ...patch, state });
  }

  /** Permanently remove one maintenance target / GitHub relation. */
  async deleteById(targetId: string): Promise<boolean> {
    if (!this.state.targets[targetId]) {
      return false;
    }
    delete this.state.targets[targetId];
    await this.save();
    return true;
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, "", { flag: "a" });
    await withFileLock(this.filePath, async () => {
      const tmpPath = `${this.filePath}.tmp`;
      await fs.writeFile(
        tmpPath,
        `${JSON.stringify(this.state, null, 2)}\n`,
        "utf-8",
      );
      await fs.rename(tmpPath, this.filePath);
    });
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "MaintenanceTargetStore not initialized. Call initialize() first.",
      );
    }
  }
}
