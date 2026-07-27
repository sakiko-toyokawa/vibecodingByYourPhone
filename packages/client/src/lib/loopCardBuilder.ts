import type { LoopCard } from "@yep-anywhere/shared";

export type LoopKind = "workspace" | "github_prompt";
export type PolicyMode = "readonly" | "modify";

export interface LoopCreateFormState {
  kind: LoopKind;
  /** workspace 类型专用：只读扫描 or 策略约束下的修改循环 */
  policyMode: PolicyMode;
  id: string;
  workspacePath: string;
  task: string;
  triggerType: "manual" | "schedule";
  cron: string;
  verifyStatic: boolean;
  verifyRuntime: boolean;
  maxTurns: string;
  maxRetries: string;
  maxTimeMinutes: string;
  modelProvider: string;
  model: string;
}

export const DEFAULT_LOOP_CREATE_FORM: LoopCreateFormState = {
  kind: "workspace",
  policyMode: "readonly",
  id: "",
  workspacePath: "",
  task: "",
  triggerType: "manual",
  cron: "0 9 * * *",
  verifyStatic: true,
  verifyRuntime: true,
  maxTurns: "1",
  maxRetries: "0",
  maxTimeMinutes: "30",
  modelProvider: "",
  model: "",
};

function parsePositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function managedGitHubWorkspacePath(loopId: string): string {
  return loopId
    ? `managed://github-workspaces/prompt-loops/${loopId}`
    : "managed://github-workspaces/prompt-loops/new-loop";
}

export function buildLoopCard(form: LoopCreateFormState): LoopCard {
  const id = form.id.trim();
  const task = form.task.trim();
  const maxTurns = parsePositiveInt(form.maxTurns, 1);
  const maxRetries = Math.min(
    parseNonNegativeInt(form.maxRetries, 0),
    Math.max(0, maxTurns - 1),
  );
  const required: LoopCard["loop"]["verification"]["required"] = [];
  if (form.verifyStatic) required.push("static");
  if (form.verifyRuntime) required.push("runtime");
  const runtime =
    form.modelProvider.trim() || form.model.trim()
      ? {
          ...(form.modelProvider.trim()
            ? { provider: form.modelProvider.trim() }
            : {}),
          ...(form.model.trim() ? { model: form.model.trim() } : {}),
        }
      : undefined;

  const base = {
    id,
    trigger:
      form.triggerType === "schedule"
        ? { type: "schedule" as const, cron: form.cron.trim() }
        : { type: "manual" as const },
    verification: {
      required,
    },
    persistence: {
      state_file: `.loop/state/${id || "new-loop"}/STATE.md`,
    },
    stop_rules: {
      max_turns: maxTurns,
      max_retries: maxRetries,
      max_time_minutes: parsePositiveInt(form.maxTimeMinutes, 30),
    },
    ...(runtime ? { runtime } : {}),
  };

  if (form.kind === "github_prompt") {
    return {
      loop: {
        ...base,
        discovery: {
          source: "github_prompt",
          query: task,
        },
        handoff: {
          default_task_type: "github_issue_repair",
          max_items_per_run: 1,
          task,
        },
        workspace: {
          strategy: "direct",
          path: managedGitHubWorkspacePath(id),
        },
        policy: {
          profile: "github_issue_local_fix",
          approval_mode: "bypass",
        },
      },
    };
  }

  return {
    loop: {
      ...base,
      handoff: {
        default_task_type: "maintenance",
        task,
      },
      workspace: {
        strategy: "direct",
        path: form.workspacePath.trim(),
      },
      ...(form.policyMode === "modify"
        ? {
            policy: {
              profile: "workspace_local_fix",
              approval_mode: "bypass" as const,
            },
          }
        : {}),
    },
  };
}
