/**
 * Phase-2 policy projection smoke test (05 阶段 2 验收 4 + bypass 冒烟):
 * mocked Supervisor（捕获并调用装配进来的 toolApprovalHook）+ 真实
 * stores + 真实 control-plane。
 *
 *  - 任务尝试 git merge → 策略钩子拦截（deny）→ run 升级 needs_human，
 *    policy_blocked + needs_human 决策落账，policy_refs 非空；
 *  - bypass 下 workspace 内文件写 → 自批准 + bypass_used 审计，run 完成；
 *  - 无 policy 块的 card：不装钩子、permissionMode=plan、prompt 只读 —
 *    既有行为原样。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  JudgmentReport,
  LoopCard,
  PermissionMode,
  RunState,
} from "@yep-anywhere/shared";
import type { Process } from "../supervisor/Process.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { ToolApprovalHook } from "../supervisor/types.js";
import {
  EXECUTOR_SUMMARY_BEGIN,
  EXECUTOR_SUMMARY_END,
} from "./assembly/runtime-input.js";
import { ControlPlane } from "./control-plane/control-plane.js";
import { RunStateStore } from "./control-plane/run-state-store.js";
import {
  RESTRICTION_RELEASE_BEGIN,
  RESTRICTION_RELEASE_END,
} from "./policy/restriction-release.js";
import { LoopRunService } from "./run-service.js";
import { buildCollectorPrompt } from "./run/artifacts.js";
import type { LoopCardStore } from "./state/loop-card-store.js";
import { RunLedgerStore } from "./state/run-ledger-store.js";
import type { VerifyRunResult } from "./verification/verify-run.js";

const SESSION_ID = "session-policy-1";
const WS = "/tmp/loop-policy-ws";

interface ScriptedToolCall {
  tool: string;
  input: unknown;
}

interface SupervisorCall {
  method: "start" | "resume";
  role: "executor" | "collector";
  cwd: string;
  mode: PermissionMode | undefined;
  text: string;
  env?: Record<string, string>;
  providerName?: string;
  model?: string;
  hadHook: boolean;
  hookResults: { behavior: string; message?: string }[];
}

/** Fake Supervisor: captures the assembled session settings and plays the
 *  scripted tool calls through the policy hook before reporting success. */
class PolicyFakeSupervisor {
  readonly calls: SupervisorCall[] = [];

  constructor(
    private readonly scripted: ScriptedToolCall[],
    private readonly finalText = [
      "turn report text",
      EXECUTOR_SUMMARY_BEGIN,
      "- 已完成：turn completed",
      "- 風險：none",
      "- 文件：none",
      EXECUTOR_SUMMARY_END,
    ].join("\n"),
  ) {}

  async startSession(
    cwd: string,
    message: { text: string },
    mode?: PermissionMode,
    settings?: {
      toolApprovalHook?: ToolApprovalHook;
      providerName?: string;
      model?: string;
    },
  ): Promise<Process> {
    const hookResults: SupervisorCall["hookResults"] = [];
    if (settings?.toolApprovalHook) {
      for (const call of this.scripted) {
        const result = await settings.toolApprovalHook(call.tool, call.input);
        if (result) {
          hookResults.push(result);
        }
      }
    }
    this.calls.push({
      method: "start",
      role: message.text.includes("Collector input bundle")
        ? "collector"
        : "executor",
      cwd,
      mode,
      text: message.text,
      env: (settings as { env?: Record<string, string> } | undefined)?.env,
      providerName: settings?.providerName,
      model: settings?.model,
      hadHook: Boolean(settings?.toolApprovalHook),
      hookResults,
    });
    return this.makeProcess(SESSION_ID);
  }

  async resumeSession(
    sessionId: string,
    cwd: string,
    message: { text: string },
    mode?: PermissionMode,
  ): Promise<Process> {
    this.calls.push({
      method: "resume",
      role: "executor",
      cwd,
      mode,
      text: message.text,
      env: undefined,
      providerName: undefined,
      model: undefined,
      hadHook: false,
      hookResults: [],
    });
    return this.makeProcess(sessionId);
  }

  private makeProcess(sessionId: string): Process {
    return {
      sessionId,
      subscribe: (listener: (event: unknown) => void) => {
        queueMicrotask(() => {
          listener({
            type: "message",
            message: {
              type: "result",
              subtype: "success",
              result: this.finalText,
              is_error: false,
              usage: { input_tokens: 100, output_tokens: 50 },
            },
          });
        });
        return () => {};
      },
      abort: async () => {},
      respondToInput: () => {},
    } as unknown as Process;
  }
}

function makeCard(withPolicy: boolean): LoopCard {
  return {
    loop: {
      id: "loop-policy",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: WS },
      verification: { required: ["static"] },
      handoff: { task: "fix src/foo.ts" },
      persistence: { state_file: "state/loop-policy.json" },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 2 },
      ...(withPolicy
        ? {
            policy: {
              profile: "workspace_local_fix" as const,
              approval_mode: "bypass" as const,
            },
          }
        : {}),
    },
  };
}

function makeGitHubPromptCard(): LoopCard {
  return {
    loop: {
      id: "github-prompt-loop",
      trigger: { type: "manual" },
      discovery: {
        source: "github_prompt",
        query: "去寻找 agent 项目的 bug 修复，优先找容易合 PR 的",
      },
      handoff: {
        default_task_type: "github_issue_repair",
        max_items_per_run: 1,
        task: "去寻找 agent 项目的 bug 修复，优先找容易合 PR 的",
      },
      workspace: {
        strategy: "direct",
        path: "managed://github-workspaces/prompt-loops/github-prompt-loop",
      },
      verification: { required: ["static"] },
      policy: {
        profile: "github_issue_local_fix",
        approval_mode: "bypass",
      },
      ...({
        runtime: {
          provider: "claude",
          model: "claude-sonnet-4-5",
        },
      } as { runtime: { provider: string; model: string } }),
      persistence: { state_file: "state/github-prompt-loop.json" },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 2 },
    },
  };
}

const PASSED_JUDGMENT: JudgmentReport = {
  overall: "passed",
  next_action: "complete",
  retryable: false,
  requires_human: false,
  evidence: ["artifact://run/verifier-reports.json"],
  unresolved_risks: [],
};

function makeVerify() {
  return async (): Promise<VerifyRunResult> => ({
    reports: [],
    judgment: PASSED_JUDGMENT,
    refs: {
      verification_input: "artifact://run/verification-input.json",
      verifier_runtime: "verifier-runtime://subprocess:static",
      verifier_report: "artifact://run/verifier-reports.json",
      judgment_report: "artifact://run/judgment-report.json",
    },
  });
}

async function withFixture(
  opts: {
    withPolicy: boolean;
    scripted: ScriptedToolCall[];
    card?: LoopCard;
    finalText?: string;
  },
  fn: (ctx: {
    service: LoopRunService;
    controlPlane: ControlPlane;
    supervisor: PolicyFakeSupervisor;
    ledgerStore: RunLedgerStore;
    stateStore: RunStateStore;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-run-policy-"));
  try {
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
    });
    const supervisor = new PolicyFakeSupervisor(opts.scripted, opts.finalText);
    const card = opts.card ?? makeCard(opts.withPolicy);
    const loopCardStore = {
      getLoop: (id: string) =>
        id === card.loop.id
          ? {
              id: card.loop.id,
              card,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              archived: false,
            }
          : undefined,
    } as LoopCardStore;
    const service = new LoopRunService({
      supervisor: supervisor as unknown as Supervisor,
      loopCardStore,
      runLedgerStore: ledgerStore,
      controlPlane,
      sleep: async () => {},
      verifyRunFn: makeVerify() as never,
      githubCredentialStore: {
        getToken: async () => "github_pat_secret",
      },
      githubToolProvisioner: {
        ensureGh: async () => ({
          installed: true,
          version: "2.64.0",
          path: "/tmp/yep/tools/gh/2.64.0/gh/bin/gh",
        }),
      },
      dataDir,
    });
    await fn({ service, controlPlane, supervisor, ledgerStore, stateStore });
    // Let in-flight ledger append chains settle before cleanup (Windows
    // fs.rm races with concurrent appends → ENOTEMPTY).
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    await rm(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

async function waitForState(
  controlPlane: ControlPlane,
  runId: string,
  expected: RunState[],
  timeoutMs = 5000,
): Promise<RunState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = controlPlane.currentStateOf(runId);
    if (state && expected.includes(state)) {
      return state;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${expected.join("/")} (current: ${state})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForCall(
  supervisor: PolicyFakeSupervisor,
  timeoutMs = 5000,
): Promise<SupervisorCall> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const call = supervisor.calls[0];
    if (call) {
      return call;
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for supervisor call");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 状态机先转移（applyJudgment 内）→ 轮末账本/handoff 落盘 → finally 才
 *  释放 active 注册，三者有天然的异步窗口；释放属实现细节，轮询等待而
 *  非瞬时断言（负载下瞬时断言会抖动）。 */
async function waitForInactive(
  service: LoopRunService,
  loopId: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (service.isRunActive(loopId)) {
    if (Date.now() > deadline) {
      throw new Error(`run for '${loopId}' still active after terminal state`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("hard gate smoke: git merge under bypass is denied and the run escalates to needs_human", async () => {
  await withFixture(
    {
      withPolicy: true,
      scripted: [{ tool: "Bash", input: { command: "git merge feature" } }],
    },
    async ({ service, controlPlane, supervisor, ledgerStore, stateStore }) => {
      const summary = await service.startRun("loop-policy", "manual");

      // judgment 本是 passed，硬闸门拦截仍把 run 升级 needs_human
      const state = await waitForState(controlPlane, summary.run_id, [
        "needs_human",
      ]);
      assert.equal(state, "needs_human");
      assert.equal(service.isRunActive("loop-policy"), true);

      // 策略钩子拦截了 merge（bypass ≠ 绕过硬闸门）
      const call = await waitForCall(supervisor);
      assert.equal(call?.hadHook, true);
      assert.equal(call?.mode, "default");
      assert.equal(call?.hookResults[0]?.behavior, "deny");
      assert.match(call?.hookResults[0]?.message ?? "", /hard gate 'merge'/);

      const record = await stateStore.load("loop-policy");
      assert.equal(record?.state, "needs_human");
      assert.ok(record?.pending_approval, "pending approval bridged");

      const decisions = await ledgerStore.readDecisionEntries(summary.run_id);
      // 工具级拦截落 policy_blocked；控制决策落 needs_human 且带 policy_refs
      assert.ok(decisions.some((d) => d.decision === "policy_blocked"));
      const control = decisions.find((d) => d.decision === "needs_human");
      assert.ok(control, "needs_human control decision ledgered");
      assert.match(control.reason, /policy gate 'merge'/);
      assert.deepEqual(control.policy_refs, ["policy://workspace_local_fix"]);

      // 02 §3 policy_projection 快照落 artifact
      const projection = await ledgerStore.readArtifact(
        summary.run_id,
        "policy-projection.json",
      );
      assert.ok(projection, "policy projection artifact written");
      const parsed = JSON.parse(projection);
      assert.equal(parsed.policy_intent_ref, "policy://workspace_local_fix");
      assert.deepEqual(parsed.hard_gates, [
        "merge",
        "deploy",
        "delete",
        "publish",
        "bill",
        "notify",
        "close",
      ]);

      // 运行账本可见真实 runtime 投影（02 §8.1：mode 是 runtime 原生
      // 模式，permissionMode 记能力快照）
      const latest = await ledgerStore.readEntry(summary.run_id);
      assert.equal(latest?.runtime.adapter, "claude");
      assert.equal(latest?.runtime.mode, "print");
      assert.match(
        latest?.runtime.adapter_capability_snapshot ?? "",
        /permissionMode=default/,
      );
      assert.match(
        latest?.runtime.adapter_capability_snapshot ?? "",
        /policy=workspace_local_fix/,
      );
      assert.match(
        latest?.runtime.adapter_capability_snapshot ?? "",
        /interrupt=graceful/,
      );
    },
  );
});

test("restriction release: approve carries exact tool call into the next turn", async () => {
  const command = "gh issue close 12 --repo owner/repo";
  const releaseText = [
    "This hard-gated action is necessary.",
    RESTRICTION_RELEASE_BEGIN,
    JSON.stringify({
      tool: "Bash",
      input: { command },
      reason: "Issue confirmed fixed",
    }),
    RESTRICTION_RELEASE_END,
    EXECUTOR_SUMMARY_BEGIN,
    "- 已完成：requested restriction release",
    "- 風險：none",
    "- 文件：none",
    EXECUTOR_SUMMARY_END,
  ].join("\n");

  await withFixture(
    {
      withPolicy: true,
      scripted: [{ tool: "Bash", input: { command } }],
      finalText: releaseText,
    },
    async ({ service, controlPlane, supervisor, ledgerStore, stateStore }) => {
      const summary = await service.startRun("loop-policy", "manual");

      const blocked = await waitForState(controlPlane, summary.run_id, [
        "needs_human",
      ]);
      assert.equal(blocked, "needs_human");
      const record = await stateStore.load("loop-policy");
      assert.deepEqual(record?.pending_approval?.tool_call, {
        tool: "Bash",
        input: { command },
        summary: command,
        reason: "Issue confirmed fixed",
      });

      await controlPlane.submitDecision(summary.run_id, "approve");
      const completed = await waitForState(controlPlane, summary.run_id, [
        "complete",
      ]);
      assert.equal(completed, "complete");
      await waitForInactive(service, "loop-policy");

      const executorCalls = supervisor.calls.filter(
        (call) => call.role === "executor",
      );
      assert.equal(executorCalls.length, 2);
      assert.equal(executorCalls[1]?.hookResults[0]?.behavior, "allow");

      const decisions = await ledgerStore.readDecisionEntries(summary.run_id);
      assert.ok(
        decisions.some(
          (entry) =>
            entry.decision === "bypass_used" &&
            /one-shot restriction release/.test(entry.reason),
        ),
      );
    },
  );
});

test("github_prompt policy runs pass GitHub env through supervisor settings", async () => {
  await withFixture(
    {
      withPolicy: true,
      scripted: [],
      card: makeGitHubPromptCard(),
    },
    async ({ service, controlPlane, supervisor }) => {
      const summary = await service.startRun("github-prompt-loop", "manual");

      const state = await waitForState(controlPlane, summary.run_id, [
        "complete",
      ]);
      assert.equal(state, "complete");

      const call = await waitForCall(supervisor);
      assert.equal(call?.mode, "bypassPermissions");
      assert.match(call?.text ?? "", /GitHub issue 修复循环/);
      assert.match(
        call?.cwd ?? "",
        /github-workspaces[/\\]prompt-loops[/\\]github-prompt-loop/,
      );
      assert.equal(call?.env?.GH_TOKEN, "github_pat_secret");
      assert.equal(call?.env?.GITHUB_TOKEN, "github_pat_secret");
      assert.match(call?.env?.PATH ?? "", /gh[/\\]bin/);
      assert.equal(call?.providerName, "claude");
      assert.equal(call?.model, "claude-sonnet-4-5");
    },
  );
});

test("collector stage writes report and handoff artifacts with GitHub runtime env", async () => {
  await withFixture(
    {
      withPolicy: true,
      scripted: [],
      card: makeGitHubPromptCard(),
    },
    async ({ service, controlPlane, supervisor, ledgerStore }) => {
      const summary = await service.startRun("github-prompt-loop", "manual");

      const state = await waitForState(controlPlane, summary.run_id, [
        "complete",
      ]);
      assert.equal(state, "complete");

      const executorCall = supervisor.calls.find(
        (call) => call.role === "executor",
      );
      const collectorCall = supervisor.calls.find(
        (call) => call.role === "collector",
      );
      assert.ok(executorCall, "executor session started");
      assert.ok(collectorCall, "collector session started");
      assert.equal(collectorCall.method, "start");
      assert.equal(collectorCall.cwd, executorCall.cwd);
      assert.equal(collectorCall.mode, "plan");
      assert.equal(collectorCall.providerName, "claude");
      assert.equal(collectorCall.model, "claude-sonnet-4-5");
      assert.equal(collectorCall.env?.GH_TOKEN, "github_pat_secret");
      assert.equal(collectorCall.env?.GITHUB_TOKEN, "github_pat_secret");
      assert.match(collectorCall.env?.PATH ?? "", /gh[/\\]bin/);
      assert.match(collectorCall.text, /Collector input bundle/);
      assert.match(collectorCall.text, /"max_items_per_run": 1/);

      const collectorInput = await ledgerStore.readArtifact(
        summary.run_id,
        "collector-input.json",
      );
      const collectorReport = await ledgerStore.readArtifact(
        summary.run_id,
        "collector-report.json",
      );
      const handoff = await ledgerStore.readArtifact(
        summary.run_id,
        "turn-handoff.json",
      );
      assert.ok(collectorInput, "collector input artifact written");
      assert.ok(collectorReport, "collector report artifact written");
      assert.ok(handoff, "turn handoff artifact written");

      const parsedReport = JSON.parse(collectorReport);
      assert.equal(parsedReport.status, "passed");
      assert.deepEqual(parsedReport.evidence_refs, [
        `artifact://${summary.run_id}/collector-output.log`,
      ]);

      const parsedHandoff = JSON.parse(handoff);
      assert.equal(parsedHandoff.run_id, summary.run_id);
      assert.equal(parsedHandoff.loop_id, "github-prompt-loop");
      assert.equal(parsedHandoff.turn, 1);
      assert.equal(
        parsedHandoff.collector_report_ref,
        `artifact://${summary.run_id}/collector-report.json`,
      );
      assert.deepEqual(parsedHandoff.actions_not_to_repeat, []);

      const latest = await ledgerStore.readEntry(summary.run_id);
      assert.ok(
        latest?.artifact_refs.includes(
          `artifact://${summary.run_id}/turn-handoff.json`,
        ),
      );
      assert.ok(
        latest?.verification_refs.verifier_report.includes("verifier-reports"),
      );
    },
  );
});

test("bypass smoke: workspace write self-approves with audit, run completes unattended", async () => {
  await withFixture(
    {
      withPolicy: true,
      scripted: [
        { tool: "Write", input: { file_path: `${WS}/src/foo.ts` } },
        { tool: "Bash", input: { command: "pnpm test" } },
      ],
    },
    async ({ service, controlPlane, supervisor, ledgerStore }) => {
      const summary = await service.startRun("loop-policy", "manual");

      const state = await waitForState(controlPlane, summary.run_id, [
        "complete",
      ]);
      assert.equal(state, "complete");
      await waitForInactive(service, "loop-policy");

      const call = await waitForCall(supervisor);
      assert.deepEqual(
        call?.hookResults.map((r) => r.behavior),
        ["allow", "allow"],
      );

      // 每次自批准各落一条 bypass_used 审计（工具名 + 判定理由）
      const decisions = await ledgerStore.readDecisionEntries(summary.run_id);
      const audits = decisions.filter((d) => d.decision === "bypass_used");
      assert.equal(audits.length, 2);
      assert.match(audits[0]?.reason ?? "", /tool=Write/);
      assert.match(audits[1]?.reason ?? "", /tool=Bash/);
      assert.ok(
        audits.every((d) =>
          d.policy_refs.includes("policy://workspace_local_fix"),
        ),
      );
    },
  );
});

test("legacy card without policy: no hook, plan mode, read-only prompt (unchanged)", async () => {
  await withFixture(
    {
      withPolicy: false,
      scripted: [{ tool: "Write", input: { file_path: `${WS}/a.ts` } }],
    },
    async ({ service, controlPlane, supervisor, ledgerStore }) => {
      const summary = await service.startRun("loop-policy", "manual");

      const call = await waitForCall(supervisor);
      // 无钩子 → 钩子不被调用（scripted 调用不发生），行为原样
      assert.equal(call?.hadHook, false);
      assert.equal(call?.hookResults.length, 0);
      assert.equal(call?.mode, "plan");
      assert.match(call?.text ?? "", /只读循环任务/);

      const state = await waitForState(controlPlane, summary.run_id, [
        "complete",
      ]);
      assert.equal(state, "complete");

      const decisions = await ledgerStore.readDecisionEntries(summary.run_id);
      assert.equal(
        decisions.filter((d) => d.decision === "bypass_used").length,
        0,
      );
      const latest = await ledgerStore.readEntry(summary.run_id);
      assert.equal(latest?.runtime.mode, "print");
      assert.match(
        latest?.runtime.adapter_capability_snapshot ?? "",
        /permissionMode=plan/,
      );
    },
  );
});

test("collector prompt exposes artifact dir and forbids Bash enumeration", () => {
  const prompt = buildCollectorPrompt("artifact://run-1/collector-input.json", {
    run_id: "run-1",
    artifact_dir: "C:/data/loops/artifacts/run-1",
  });
  assert.match(prompt, /C:\/data\/loops\/artifacts\/run-1/);
  assert.match(prompt, /Use Read\/Glob\/Grep/);
  assert.match(
    prompt,
    /Do not use Bash to enumerate server-managed directories/,
  );
});
