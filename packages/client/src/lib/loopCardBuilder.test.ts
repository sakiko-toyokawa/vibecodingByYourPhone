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
    verifyStatic: false,
    verifyRuntime: false,
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
  assertEqual(card.loop.stop_rules.max_turns, 3);
  const runtime = (
    card.loop as { runtime?: { provider?: string; model?: string } }
  ).runtime;
  assertEqual(runtime?.provider, "claude");
  assertEqual(runtime?.model, "claude-sonnet-4-5");
  assertDeepEqual(card.loop.trigger, {
    type: "schedule",
    cron: "0 9 * * *",
  });
  assertDeepEqual(card.loop.verification.required, []);
}

function testGithubPromptLoopRespectsExplicitStaticRuntime(): void {
  const card = buildLoopCard({
    ...DEFAULT_LOOP_CREATE_FORM,
    kind: "github_prompt",
    id: "github-explicit-checks",
    task: "fix a bug",
    verifyStatic: true,
    verifyRuntime: true,
    verifyInteraction: true,
  });

  assertDeepEqual(card.loop.verification.required, [
    "static",
    "runtime",
    "interaction",
  ]);
}

function testGithubPromptLoopPassesHumanGateSlaPolicy(): void {
  const card = buildLoopCard({
    ...DEFAULT_LOOP_CREATE_FORM,
    kind: "github_prompt",
    id: "github-sla",
    task: "fix docs",
    humanGateSlaPolicy: "auto_approve_low_risk",
  });

  assertEqual(card.loop.human_gate?.sla?.policy, "auto_approve_low_risk");
  assertEqual(card.loop.human_gate?.sla?.abandon_after_minutes, 7 * 24 * 60);
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
  assertEqual(card.loop.workspace.strategy, "direct");
  assertEqual(card.loop.policy, undefined);
  assertEqual(card.loop.stop_rules.max_turns, 5);
}

function testBuildsWorkspaceLoopWithWorktreeStrategy(): void {
  const card = buildLoopCard({
    ...DEFAULT_LOOP_CREATE_FORM,
    id: "fix-things",
    workspacePath: "E:/projects/my-app",
    workspaceStrategy: "worktree",
    policyMode: "modify",
    task: "Fix the lint errors.",
  });

  assertEqual(card.loop.workspace.strategy, "worktree");
  assertEqual(card.loop.workspace.path, "E:/projects/my-app");
  assertEqual(card.loop.policy?.profile, "workspace_local_fix");
}

testBuildsGithubPromptLoop();
testGithubPromptLoopRespectsExplicitStaticRuntime();
testGithubPromptLoopPassesHumanGateSlaPolicy();
testBuildsWorkspaceLoop();
testBuildsWorkspaceLoopWithWorktreeStrategy();

console.log("loopCardBuilder tests passed");
