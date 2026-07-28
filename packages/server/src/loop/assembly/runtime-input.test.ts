import assert from "node:assert/strict";
import { test } from "node:test";
import type { ImprovementProposal, LoopCard } from "@yep-anywhere/shared";
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
  assert.match(input.prompt, /GitHub issue 修复循环/);
  assert.match(input.prompt, /GitHub CLI/);
  assert.match(input.prompt, /全 GitHub 公开仓库/);
  assert.match(input.prompt, /每次最多选择 1 个 issue/);
  assert.match(input.prompt, /服务端管理的主工作区/);
  assert.match(input.prompt, /不要 fork、push、创建 pull request/);
  assert.match(input.prompt, /PR 标题和正文草稿/);
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
  assert.match(input.prompt, /结构化自述/);
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

test("policy bridge guard: codex allowed (06 #39), unverified bridges fail-closed (06 #24)", () => {
  // codex 桥策略投影已接线 (policyHookWired → on-request/read-only)——
  // 装配放行, 且 policyProjection.sandbox 如实记 read-only
  const codexCard = {
    loop: {
      ...githubPromptCard().loop,
      runtime: { provider: "codex" },
    },
  } as LoopCard;
  const codexInput = assembleRuntimeInput(
    codexCard,
    buildIntentContract(codexCard, { runId: "run-1", source: "manual" }),
  );
  assert.equal(
    codexInput.policyProfile?.policy_profile,
    "github_issue_local_fix",
  );
  assert.equal(codexInput.policyProjection?.sandbox, "read-only");
  assert.equal(codexInput.nativeInvocation.bridge, "app_server");

  // 未接线桥 (gemini 等) 仍 fail-closed
  const geminiCard = {
    loop: {
      ...githubPromptCard().loop,
      runtime: { provider: "gemini" },
    },
  } as LoopCard;
  assert.throws(
    () =>
      assembleRuntimeInput(
        geminiCard,
        buildIntentContract(geminiCard, { runId: "run-2", source: "manual" }),
      ),
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
  assert.equal(ok.policyProjection?.sandbox, "none");
});

test("execution contract / native_invocation / observability structured (02 §3)", () => {
  const card = githubPromptCard();
  const contract = buildIntentContract(card, {
    runId: "run-1",
    source: "cron",
  });
  const input = assembleRuntimeInput(card, contract, [], {
    github: { ghPath: "E:/tools/gh/bin/gh.exe", token: "t" },
  });

  // execution_contract 五字段: goal/scope 投影, constraints 进 prompt
  assert.equal(input.executionContract.goal, contract.raw_goal);
  assert.deepEqual(input.executionContract.success_criteria, [
    ...contract.success_criteria,
  ]);
  assert.ok(input.executionContract.constraints.length > 0);
  assert.ok(input.prompt.includes("约束："));
  assert.ok(input.prompt.includes("必须留下的输出证据："));
  // policy 写卡 → changed_files/commands_run; 该卡验证段为 review
  // (无 static/runtime) → 无 test_results
  assert.deepEqual(input.executionContract.required_output, [
    "summary",
    "known_risks",
    "changed_files",
    "commands_run",
  ]);

  // native_invocation: claude → agent_sdk/sdk/print 真实投影
  assert.equal(input.nativeInvocation.adapter, "claude");
  assert.equal(input.nativeInvocation.bridge, "agent_sdk");
  assert.equal(input.nativeInvocation.surface, "sdk");
  assert.equal(input.nativeInvocation.mode, "print");
  assert.equal(input.nativeInvocation.resume_ref, null);
  assert.equal(input.nativeInvocation.timeout_seconds, null);

  // observability 如实声明: stderr/transcript 无通道记 false
  assert.equal(input.observability.capture_stdout, true);
  assert.equal(input.observability.capture_stderr, false);
  assert.equal(input.observability.capture_structured_output, true);
  assert.equal(input.observability.capture_transcript, false);
});

test("legacy read-only card: required_output 精简且无 changed_files", () => {
  const card: LoopCard = {
    loop: {
      id: "plain-loop",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: "/tmp/x" },
      verification: { required: ["static"] },
      persistence: { state_file: ".loop/STATE.md" },
      stop_rules: { max_turns: 3, max_time_minutes: 10, max_retries: 2 },
    },
  };
  const input = assembleRuntimeInput(
    card,
    buildIntentContract(card, { runId: "run-1", source: "manual" }),
  );
  assert.deepEqual(input.executionContract.required_output, [
    "summary",
    "known_risks",
    "test_results",
  ]);
  // adapter_policy 提供超时时 native_invocation 如实投影
  const withTimeout = assembleRuntimeInput(
    card,
    buildIntentContract(card, { runId: "run-2", source: "manual" }),
    [
      {
        proposal_id: "p-1",
        type: "runtime_adapter_proposal",
        source_patterns: [],
        summary: "s",
        target: "plain-loop.adapter.timeout_config",
        expected_effect: "e",
        risk: "low",
        validation_plan: "v",
        status: "published",
        created_by: "human",
        payload: { adapter_policy: { timeout_seconds: 600 } },
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ],
  );
  assert.equal(withTimeout.nativeInvocation.timeout_seconds, 600);
});

test("policy_profile override resolves real rule differences from the registry (profiles.ts)", () => {
  const card = githubPromptCard();
  const strictProposal: ImprovementProposal = {
    proposal_id: "p-strict",
    type: "policy_profile_proposal",
    source_patterns: [],
    summary: "use strict review profile",
    target: "github-agent-bugs.policy_profile",
    expected_effect: "e",
    risk: "high",
    validation_plan: "v",
    status: "published",
    created_by: "human",
    payload: { policy_profile: "loop_strict_review" },
    created_at: "2026-01-01T00:00:00.000Z",
  };

  const input = assembleRuntimeInput(
    card,
    buildIntentContract(card, { runId: "run-1", source: "cron" }),
    [strictProposal],
    { github: { ghPath: "E:/tools/gh/bin/gh.exe", token: "t" } },
  );

  // 覆盖档名经注册表解析出真实规则差异, 不只是换标签
  assert.equal(input.policyProfile?.policy_profile, "loop_strict_review");
  assert.equal(input.policyProfile?.risk_rules.medium, "review_or_policy");
  assert.equal(input.policyProfile?.risk_rules.high, "human_required");
  assert.equal(input.policyProfile?.risk_rules.low, "auto");
  assert.equal(input.policyProfile?.bypass_scope?.allow_local_commands, false);

  // 未注册档名回落风险模型.md 默认值
  const defaultInput = assembleRuntimeInput(
    card,
    buildIntentContract(card, { runId: "run-2", source: "cron" }),
    [
      {
        ...strictProposal,
        proposal_id: "p-unknown",
        payload: { policy_profile: "no_such_profile" },
      },
    ],
    { github: { ghPath: "E:/tools/gh/bin/gh.exe", token: "t" } },
  );
  assert.equal(
    defaultInput.policyProfile?.risk_rules.medium,
    "auto_if_in_workspace",
  );
  assert.equal(
    defaultInput.policyProfile?.bypass_scope?.allow_local_commands,
    true,
  );
});

test("github_prompt legacy (no policy) branch also injects GitHub env", () => {
  const card = githubPromptCard();
  card.loop.policy = undefined;
  const input = assembleRuntimeInput(
    card,
    buildIntentContract(card, { runId: "run-1", source: "cron" }),
    [],
    {
      github: { ghPath: "E:/tools/gh/bin/gh.exe", token: "github_pat_secret" },
    },
  );
  assert.equal(input.permissionMode, "plan");
  assert.equal(input.env?.GH_TOKEN, "github_pat_secret");
  assert.equal(input.env?.GITHUB_TOKEN, "github_pat_secret");
  assert.match(input.env?.PATH ?? "", /E:[/\\]tools[/\\]gh[/\\]bin/);
});

test("contract.target.files 装配为「重点范围」注意力提示小节（02 §2）", () => {
  const card: LoopCard = {
    loop: {
      id: "target-loop",
      trigger: { type: "manual" },
      handoff: {
        task: "审查 packages/server/src/loop/run-service.ts 的停止逻辑",
      },
      workspace: { strategy: "direct", path: "/tmp/x" },
      verification: { required: [] },
      persistence: { state_file: ".loop/STATE.md" },
      stop_rules: { max_turns: 3, max_time_minutes: 10, max_retries: 2 },
    },
  } as LoopCard;
  const contract = buildIntentContract(card, {
    runId: "run-1",
    source: "manual",
  });
  assert.deepEqual(contract.target?.files, [
    "packages/server/src/loop/run-service.ts",
  ]);

  const input = assembleRuntimeInput(card, contract);
  assert.match(input.prompt, /重点范围（注意力提示，非访问控制/);
  assert.match(input.prompt, /- packages\/server\/src\/loop\/run-service\.ts/);

  // 无 target 的 contract 不出现该小节
  const plainCard: LoopCard = {
    loop: {
      ...card.loop,
      handoff: { task: "扫描工作区并总结最近的改动" },
    },
  } as LoopCard;
  const plainInput = assembleRuntimeInput(
    plainCard,
    buildIntentContract(plainCard, { runId: "run-2", source: "manual" }),
  );
  assert.ok(!plainInput.prompt.includes("重点范围"));
});
