import {
  DEFAULT_LOOP_CREATE_FORM,
  buildLoopCard,
  managedGitHubWorkspacePath,
} from "./loopCardBuilder.js";

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(
      message ?? `Expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

function assertDeepEqual<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ??
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function testBuildsGithubPromptLoop(): void {
  const card = buildLoopCard({
    ...DEFAULT_LOOP_CREATE_FORM,
    kind: "github_prompt",
    id: "agent-bug-fixes",
    task: "去寻找 agent 项目的 bug 修复，注意查看提交 PR 规范，优先找容易合 PR 的",
    triggerType: "schedule",
    cron: "0 9 * * *",
    maxTurns: "3",
    maxRetries: "1",
    maxTimeMinutes: "60",
    modelProvider: "claude",
    model: "claude-sonnet-4-5",
  });

  assertEqual(card.loop.discovery?.source, "github_prompt");
  assertEqual(
    card.loop.discovery?.query,
    "去寻找 agent 项目的 bug 修复，注意查看提交 PR 规范，优先找容易合 PR 的",
  );
  assertEqual(card.loop.handoff?.default_task_type, "github_issue_repair");
  assertEqual(card.loop.handoff?.max_items_per_run, 1);
  assertEqual(card.loop.handoff?.task, card.loop.discovery?.query);
  assertEqual(
    card.loop.workspace.path,
    managedGitHubWorkspacePath("agent-bug-fixes"),
  );
  assertEqual(
    card.loop.workspace.path,
    "managed://github-workspaces/prompt-loops/agent-bug-fixes",
  );
  assertEqual(card.loop.policy?.profile, "github_issue_local_fix");
  assertEqual(card.loop.policy?.approval_mode, "bypass");
  const runtime = (
    card.loop as { runtime?: { provider?: string; model?: string } }
  ).runtime;
  assertEqual(runtime?.provider, "claude");
  assertEqual(runtime?.model, "claude-sonnet-4-5");
  assertDeepEqual(card.loop.trigger, {
    type: "schedule",
    cron: "0 9 * * *",
  });
}

function testBuildsWorkspaceLoop(): void {
  const card = buildLoopCard({
    ...DEFAULT_LOOP_CREATE_FORM,
    id: "daily-check",
    workspacePath: "E:/projects/my-app",
    task: "Summarize recent changes and report risks.",
  });

  assertEqual(card.loop.discovery, undefined);
  assertEqual(card.loop.handoff?.default_task_type, "maintenance");
  assertEqual(card.loop.workspace.path, "E:/projects/my-app");
  assertEqual(card.loop.policy, undefined);
}

testBuildsGithubPromptLoop();
testBuildsWorkspaceLoop();

console.log("loopCardBuilder tests passed");
