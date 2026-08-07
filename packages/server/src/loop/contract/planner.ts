import {
  type SubTask,
  type TaskPlan,
  TaskPlanSchema,
} from "@yep-anywhere/shared";
import { getProvider } from "../../sdk/providers/index.js";
import type { ProviderName } from "../../sdk/providers/types.js";
import type { UserMessage } from "../../sdk/types.js";

/**
 * Planner Agent — produces a TaskPlan at intent-contract time.
 *
 * The planner is an isolated Claude session that decomposes a complex task
 * into ordered subtasks. It runs before the loop's execution turns and its
 * output is embedded into the IntentContract so the run-service can drive
 * one subtask per turn.
 *
 * Failure policy: any error or unparseable output falls back to a single
 * subtask containing the original task, preserving existing single-turn
 * behavior.
 */

const DEFAULT_PLANNER_TIMEOUT_MS = 60_000;
const MAX_SUBTASKS = 5;

function buildPlannerPrompt(task: string): string {
  return [
    "You are a task planner. Analyze the following task and decide whether it should be decomposed into multiple sequential subtasks or handled as a single task.",
    "Each subtask must be completable in one turn of an autonomous coding loop, and should take no more than 5 minutes to complete.",
    "Return ONLY a JSON array of subtasks with this exact shape:",
    '[{"id":"subtask-1","description":"...","success_criteria":["..."],"target_artifacts":["..."]},...]',
    "Rules:",
    "- If the task is simple, atomic, or can reasonably be completed in one turn, return a single subtask.",
    "- If the task is complex, has clear sequential steps, or benefits from intermediate verification, return 3 to 5 subtasks (never more than 5).",
    "- Order subtasks logically (research → plan → implement → verify → finalize).",
    "- Each subtask must have a clear, testable success criteria.",
    "- Each subtask must be small enough to complete in one turn (≤5 minutes of work). Avoid large subtasks that combine multiple steps.",
    "- target_artifacts lists expected files or outputs (optional, can be empty).",
    "- Do not include any text outside the JSON array.",
    "- Do NOT call any tools. You do not need to inspect the workspace or run commands to produce the plan. Return the JSON directly.",
    "",
    "Task:",
    task,
  ].join("\n");
}

function extractJsonArray(text: string): unknown[] | null {
  const trimmed = text.trim();
  // Fast path: the whole text is JSON.
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // ignore
  }
  // Look for the first JSON array in the text.
  const start = trimmed.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let isEscaping = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (isEscaping) {
      isEscaping = false;
      continue;
    }
    if (ch === "\\" && inString) {
      isEscaping = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (depth === 0) {
      const candidate = trimmed.slice(start, i + 1);
      try {
        const parsed = JSON.parse(candidate) as unknown;
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function normalizeSubtasks(raw: unknown[]): SubTask[] {
  const subtasks: SubTask[] = [];
  for (let i = 0; i < raw.length && subtasks.length < MAX_SUBTASKS; i++) {
    const item = raw[i] as Record<string, unknown>;
    const id =
      typeof item?.id === "string" && item.id.trim()
        ? item.id.trim()
        : `subtask-${subtasks.length + 1}`;
    const description =
      typeof item?.description === "string" && item.description.trim()
        ? item.description.trim()
        : null;
    const successCriteria = Array.isArray(item?.success_criteria)
      ? item.success_criteria
          .filter((c): c is string => typeof c === "string")
          .map((c) => c.trim())
          .filter(Boolean)
      : [];
    const targetArtifacts = Array.isArray(item?.target_artifacts)
      ? item.target_artifacts
          .filter((a): a is string => typeof a === "string")
          .map((a) => a.trim())
          .filter(Boolean)
      : [];
    if (!description) continue;
    if (successCriteria.length === 0) continue;
    subtasks.push({
      id,
      description,
      success_criteria: successCriteria,
      target_artifacts: targetArtifacts,
    });
  }
  return subtasks;
}

export interface PlannerServiceOptions {
  providerName?: ProviderName;
  timeoutMs?: number;
  /** Test seam: override the provider factory. */
  providerFactory?: (name: ProviderName) => ReturnType<typeof getProvider>;
}

export class PlannerService {
  private readonly defaultProviderName: ProviderName;
  private readonly timeoutMs: number;
  private readonly providerFactory: (
    name: ProviderName,
  ) => ReturnType<typeof getProvider>;

  constructor(options: PlannerServiceOptions = {}) {
    this.defaultProviderName = options.providerName ?? "claude";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PLANNER_TIMEOUT_MS;
    this.providerFactory = options.providerFactory ?? getProvider;
  }

  /**
   * Decompose a task into a TaskPlan. Always returns a valid plan; on any
   * failure the plan contains a single subtask with the original task.
   *
   * providerName / model are taken from the loop's runtime settings when
   * provided; otherwise the service defaults are used.
   */
  async planTask(
    task: string,
    opts: { providerName?: ProviderName; model?: string } = {},
  ): Promise<TaskPlan> {
    const planId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fallback = this.singleSubtaskPlan(planId, task);
    const providerName = opts.providerName ?? this.defaultProviderName;

    const provider = this.providerFactory(providerName);
    if (!provider) {
      return fallback;
    }
    if (!(await provider.isInstalled())) {
      return fallback;
    }
    if (!(await provider.isAuthenticated())) {
      return fallback;
    }

    const prompt = buildPlannerPrompt(task);
    const message: UserMessage = { text: prompt };

    try {
      const session = await provider.startSession({
        cwd: process.cwd(),
        initialMessage: message,
        permissionMode: "plan",
        model: opts.model,
        // Planner is read-only; deny file-mutating tools.
        onToolApproval: async () => ({
          behavior: "deny",
          message: "Planner session is read-only.",
        }),
      });

      const iterator = session.iterator;
      let finalText = "";

      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("planner timeout")), this.timeoutMs);
      });

      try {
        while (true) {
          const result = await Promise.race([iterator.next(), timeout]);
          if (result.done) break;
          const message = result.value;
          if (message.type === "result" && typeof message.result === "string") {
            finalText = message.result;
            break;
          }
        }
      } finally {
        session.abort();
      }

      const rawArray = extractJsonArray(finalText);
      if (!rawArray) {
        return fallback;
      }
      const subtasks = normalizeSubtasks(rawArray);
      if (subtasks.length === 0) {
        return fallback;
      }

      const plan: TaskPlan = {
        plan_id: planId,
        created_at: new Date().toISOString(),
        subtasks,
      };
      return TaskPlanSchema.parse(plan);
    } catch {
      return fallback;
    }
  }

  private singleSubtaskPlan(planId: string, task: string): TaskPlan {
    return {
      plan_id: planId,
      created_at: new Date().toISOString(),
      subtasks: [
        {
          id: "subtask-1",
          description: task,
          success_criteria: ["Task completed successfully"],
          target_artifacts: [],
        },
      ],
    };
  }
}
