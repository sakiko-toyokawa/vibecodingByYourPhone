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
import { ControlPlane } from "./control-plane/control-plane.js";
import { RunStateStore } from "./control-plane/run-state-store.js";
import { LoopRunService } from "./run-service.js";
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
  mode: PermissionMode | undefined;
  text: string;
  hadHook: boolean;
  hookResults: { behavior: string; message?: string }[];
}

/** Fake Supervisor: captures the assembled session settings and plays the
 *  scripted tool calls through the policy hook before reporting success. */
class PolicyFakeSupervisor {
  readonly calls: SupervisorCall[] = [];

  constructor(private readonly scripted: ScriptedToolCall[]) {}

  async startSession(
    _cwd: string,
    message: { text: string },
    mode?: PermissionMode,
    settings?: { toolApprovalHook?: ToolApprovalHook },
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
      mode,
      text: message.text,
      hadHook: Boolean(settings?.toolApprovalHook),
      hookResults,
    });
    return this.makeProcess(SESSION_ID);
  }

  async resumeSession(
    sessionId: string,
    _cwd: string,
    message: { text: string },
    mode?: PermissionMode,
  ): Promise<Process> {
    this.calls.push({
      method: "resume",
      mode,
      text: message.text,
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
              result: "turn report text",
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
      persistence: { state_file: "state/loop-policy.json" },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 2 },
      ...(withPolicy ? { policy: { approval_mode: "bypass" as const } } : {}),
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
  opts: { withPolicy: boolean; scripted: ScriptedToolCall[] },
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
    const supervisor = new PolicyFakeSupervisor(opts.scripted);
    const card = makeCard(opts.withPolicy);
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
      const call = supervisor.calls[0];
      assert.equal(call?.hadHook, true);
      assert.equal(call?.mode, "bypassPermissions");
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
      assert.deepEqual(control.policy_refs, ["policy://loop_bypass"]);

      // 02 §3 policy_projection 快照落 artifact
      const projection = await ledgerStore.readArtifact(
        summary.run_id,
        "policy-projection.json",
      );
      assert.ok(projection, "policy projection artifact written");
      const parsed = JSON.parse(projection);
      assert.equal(parsed.policy_intent_ref, "policy://loop_bypass");
      assert.deepEqual(parsed.hard_gates, [
        "merge",
        "deploy",
        "delete",
        "publish",
        "bill",
        "notify",
        "close",
      ]);

      // 运行账本可见能力快照
      const latest = await ledgerStore.readEntry(summary.run_id);
      assert.equal(latest?.runtime.mode, "bypassPermissions");
      assert.match(
        latest?.runtime.adapter_capability_snapshot ?? "",
        /policy=loop_bypass/,
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
      assert.equal(service.isRunActive("loop-policy"), false);

      const call = supervisor.calls[0];
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
        audits.every((d) => d.policy_refs.includes("policy://loop_bypass")),
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

      const call = supervisor.calls[0];
      // 无钩子 → 钩子不被调用（scripted 调用不发生），行为原样
      assert.equal(call?.hadHook, false);
      assert.equal(call?.hookResults.length, 0);
      assert.equal(call?.mode, "plan");
      assert.match(call?.text ?? "", /READ-ONLY/);

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
      assert.equal(latest?.runtime.mode, "plan");
    },
  );
});
