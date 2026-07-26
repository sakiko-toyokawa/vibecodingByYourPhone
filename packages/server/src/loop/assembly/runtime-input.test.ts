import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import { buildIntentContract } from "../contract/intent-contract.js";
import {
  AssemblyError,
  EXECUTOR_SUMMARY_BEGIN,
  EXECUTOR_SUMMARY_END,
  assembleRuntimeInput,
  extractExecutorSummary,
} from "./runtime-input.js";

function githubPromptCard(): LoopCard {
  return {
    loop: {
      id: "github-agent-bugs",
      trigger: { type: "schedule", cron: "0 9 * * *" },
      discovery: {
        source: "github_prompt",
        query:
          "去寻找 agent 项目的 bug 修复，注意查看提交 PR 规范，优先找容易合 PR 的",
      },
      handoff: {
        default_task_type: "github_issue_repair",
        max_items_per_run: 1,
        task: "去寻找 agent 项目的 bug 修复，注意查看提交 PR 规范，优先找容易合 PR 的",
      },
      workspace: {
        strategy: "direct",
        path: "E:/data/github-workspaces/prompt-loops/github-agent-bugs",
      },
      verification: { required: ["review"] },
      policy: {
        profile: "github_issue_local_fix",
        approval_mode: "bypass",
      },
      persistence: { state_file: ".loop/state/github-agent-bugs/STATE.md" },
      stop_rules: { max_turns: 3, max_time_minutes: 60, max_retries: 1 },
    },
  };
}

test("github_prompt loops assemble as agent-led GitHub repair runs", () => {
  const card = githubPromptCard();
  const contract = buildIntentContract(card, {
    runId: "run-1",
    source: "cron",
  });

  const input = assembleRuntimeInput(card, contract, [], {
    github: {
      ghPath: "E:/tools/gh/bin/gh.exe",
      token: "github_pat_secret",
    },
  });

  assert.equal(input.permissionMode, "bypassPermissions");
  assert.equal(input.env?.GH_TOKEN, "github_pat_secret");
  assert.equal(input.env?.GITHUB_TOKEN, "github_pat_secret");
  assert.match(input.env?.PATH ?? "", /E:[/\\]tools[/\\]gh[/\\]bin/);
  assert.match(input.prompt, /GitHub issue repair loop/);
  assert.match(input.prompt, /Use GitHub CLI/);
  assert.match(input.prompt, /全 GitHub 公开仓库/);
  assert.match(input.prompt, /每次最多选择 1 个 issue/);
  assert.match(input.prompt, /server-managed parent workspace/);
  assert.match(input.prompt, /Do NOT fork, push, create a pull request/);
  assert.match(input.prompt, /PR title and body draft/);
  assert.match(input.prompt, /去寻找 agent 项目的 bug 修复/);
});

test("assembled prompt requires the marked executor summary block (02 §5)", () => {
  const card = githubPromptCard();
  const contract = buildIntentContract(card, {
    runId: "run-1",
    source: "cron",
  });

  const input = assembleRuntimeInput(card, contract, [], {
    github: { ghPath: "E:/tools/gh/bin/gh.exe", token: "t" },
  });

  assert.ok(input.prompt.includes(EXECUTOR_SUMMARY_BEGIN));
  assert.ok(input.prompt.includes(EXECUTOR_SUMMARY_END));
  assert.match(input.prompt, /self-summary/);
});

test("extractExecutorSummary: extracts the marked block, null when absent", () => {
  const report = [
    "1. Scope scanned",
    "2. Findings ...",
    EXECUTOR_SUMMARY_BEGIN,
    "- Done: scanned src/",
    "- Not done: no tests run (read-only)",
    "- Risks: none",
    "- Files: src/foo.ts",
    EXECUTOR_SUMMARY_END,
    "trailing text",
  ].join("\n");
  const summary = extractExecutorSummary(report);
  assert.ok(summary?.includes("- Done: scanned src/"));
  assert.ok(!summary?.includes("trailing text"));

  assert.equal(extractExecutorSummary("no markers here"), null);
  assert.equal(
    extractExecutorSummary(
      `${EXECUTOR_SUMMARY_BEGIN}   ${EXECUTOR_SUMMARY_END}`,
    ),
    null,
  );
});

test("policy × non-Claude bridge is fail-closed (06 偏差 #24)", () => {
  const codexCard = {
    loop: {
      ...githubPromptCard().loop,
      runtime: { provider: "codex" },
    },
  } as LoopCard;
  const contract = buildIntentContract(codexCard, {
    runId: "run-1",
    source: "manual",
  });

  // codex 桥会把 bypassPermissions 映射成 approvalPolicy "never"——策略
  // 钩子不会触发，装配必须拒绝而不是产出无策略的 RuntimeInput
  assert.throws(
    () => assembleRuntimeInput(codexCard, contract),
    (error: unknown) =>
      error instanceof AssemblyError &&
      /cannot enforce it/.test((error as Error).message),
  );

  // claude（缺省 provider 与显式）不受影响：canUseTool 逐调用触发，钩子
  // 是已验证的规则来源
  const claudeCard = {
    loop: {
      ...githubPromptCard().loop,
      runtime: { provider: "claude" },
    },
  } as LoopCard;
  const ok = assembleRuntimeInput(
    claudeCard,
    buildIntentContract(claudeCard, { runId: "run-1", source: "manual" }),
  );
  assert.equal(ok.permissionMode, "bypassPermissions");
});
