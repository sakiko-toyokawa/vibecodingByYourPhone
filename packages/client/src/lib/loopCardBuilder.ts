import type { LoopCard } from "@yep-anywhere/shared";

export type LoopKind = "workspace" | "github_prompt";
export type PolicyMode = "readonly" | "modify";
export type WorkspaceStrategy = "direct" | "worktree";

export interface LoopCreateFormState {
  kind: LoopKind;
  /** workspace 类型专用：只读扫描 or 策略约束下的修改循环 */
  policyMode: PolicyMode;
  /** workspace 类型专用：direct 直接在原目录 / worktree 隔离副本 */
  workspaceStrategy: WorkspaceStrategy;
  id: string;
  workspacePath: string;
  task: string;
  triggerType: "manual" | "schedule";
  cron: string;
  verifyStatic: boolean;
  verifyRuntime: boolean;
  verifyInteraction: boolean;
  interactionUrl: string;
  interactionStartCommand: string;
  maxTurns: string;
  maxRetries: string;
  maxTimeMinutes: string;
  modelProvider: string;
  model: string;
}

export const DEFAULT_LOOP_CREATE_FORM: LoopCreateFormState = {
  kind: "workspace",
  policyMode: "readonly",
  workspaceStrategy: "direct",
  id: "",
  workspacePath: "",
  task: "",
  triggerType: "manual",
  cron: "0 9 * * *",
  verifyStatic: true,
  verifyRuntime: true,
  verifyInteraction: false,
  interactionUrl: "http://localhost:3400",
  interactionStartCommand: "",
  maxTurns: "5",
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

/** Strip surrounding quotes that users sometimes paste into path inputs. */
function stripSurroundingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function buildLoopCard(form: LoopCreateFormState): LoopCard {
  const id = form.id.trim();
  const task = form.task.trim();
  const workspacePath = stripSurroundingQuotes(form.workspacePath);
  const maxTurns = parsePositiveInt(form.maxTurns, 1);
  // 06 偏差 #31: max_retries >= max_turns 合法 (预算同时生效、先触者停),
  // 不再强制 maxRetries < maxTurns。
  const maxRetries = parseNonNegativeInt(form.maxRetries, 0);
  const buildRequired = (
    includeCodeChecks: boolean,
  ): LoopCard["loop"]["verification"]["required"] => {
    const required: LoopCard["loop"]["verification"]["required"] = [];
    if (includeCodeChecks && form.verifyStatic) required.push("static");
    if (includeCodeChecks && form.verifyRuntime) required.push("runtime");
    if (form.verifyInteraction) required.push("interaction");
    return required;
  };
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
      required: [],
      ...(form.verifyInteraction
        ? {
            interaction: {
              enabled: true,
              ...(form.interactionUrl.trim()
                ? { url: form.interactionUrl.trim() }
                : {}),
              ...(form.interactionStartCommand.trim()
                ? { start_command: form.interactionStartCommand.trim() }
                : {}),
            },
          }
        : {}),
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
        verification: {
          ...base.verification,
          required: buildRequired(true),
        },
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
      verification: {
        ...base.verification,
        required: buildRequired(true),
      },
      handoff: {
        default_task_type: "maintenance",
        task,
      },
      workspace: {
        strategy: form.workspaceStrategy,
        path: workspacePath,
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
