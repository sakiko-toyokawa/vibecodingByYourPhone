/**
 * maker→checker 链路的 run-service 集成测试（修复 docs/plans/
 * loop-spec-gap-fix-plan.md 的 #3/#6/#7/#9/#10）：
 *
 *  - 策略 run 的验证输入带齐真实证据：permission_event_refs（钩子裁决
 *    落盘）、policy_intent_ref（turn 1 投影快照）、runtime_event_refs
 *    （轮内消息流落盘）、known_failure_patterns（失败模式账本 open 模式）；
 *  - 验证层自身崩溃不再静默判过：合成 inconclusive + requires_human 的
 *    judgment → run 升级 needs_human，错误落 verification-error artifact。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  FailurePattern,
  ImprovementProposal,
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
import { LoopRunService } from "./run-service.js";
import { FailurePatternStore } from "./state/failure-pattern-store.js";
import type { LoopCardStore } from "./state/loop-card-store.js";
import { ProposalStore } from "./state/proposal-store.js";
import { RunLedgerStore } from "./state/run-ledger-store.js";
import type {
  VerifyRunInput,
  VerifyRunResult,
} from "./verification/verify-run.js";

const SESSION_ID = "session-verify-1";
const WS = "/tmp/loop-verify-ws";

const TURN_REPORT = [
  "1. Scope scanned",
  "2. Findings: none",
  EXECUTOR_SUMMARY_BEGIN,
  "- Done: scanned src/",
  "- Not done: nothing",
  "- Risks: none",
  "- Files: src/foo.ts",
  EXECUTOR_SUMMARY_END,
].join("\n");

const PASSED_JUDGMENT: JudgmentReport = {
  overall: "passed",
  next_action: "complete",
  retryable: false,
  requires_human: false,
  evidence: [],
  unresolved_risks: [],
};

/** Fake Supervisor: plays the scripted tool calls through the policy hook,
 *  emits one assistant message + a success result per session. silent 模式
 *  下进程永不发声 (供 adapter_policy 超时用例)。 */
class VerifyFakeSupervisor {
  /** 每次 startSession 的 settings 快照 (model 覆盖断言用)。 */
  readonly settingsSeen: ({ model?: string } | undefined)[] = [];
  /** 每次 startSession 的 prompt 文本 (memory packet / 装配断言用)。 */
  readonly textsSeen: string[] = [];

  constructor(
    private readonly scripted: { tool: string; input: unknown }[],
    private readonly silent = false,
  ) {}

  async startSession(
    _cwd: string,
    _message: { text: string },
    _mode?: PermissionMode,
    settings?: { toolApprovalHook?: ToolApprovalHook; model?: string },
  ): Promise<Process> {
    this.settingsSeen.push(settings);
    this.textsSeen.push(_message.text);
    if (settings?.toolApprovalHook) {
      for (const call of this.scripted) {
        await settings.toolApprovalHook(call.tool, call.input);
      }
    }
    return this.makeProcess(SESSION_ID);
  }

  async resumeSession(sessionId: string): Promise<Process> {
    return this.makeProcess(sessionId);
  }

  private makeProcess(sessionId: string): Process {
    return {
      sessionId,
      subscribe: (listener: (event: unknown) => void) => {
        if (this.silent) {
          return () => {};
        }
        queueMicrotask(() => {
          listener({
            type: "message",
            message: { type: "assistant", message: { content: [] } },
          });
          listener({
            type: "message",
            message: {
              type: "result",
              subtype: "success",
              result: TURN_REPORT,
              is_error: false,
              usage: { input_tokens: 10, output_tokens: 5 },
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

function makeCard(withPolicy: boolean, provider?: string): LoopCard {
  return {
    loop: {
      id: "loop-verify",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: WS },
      verification: { required: ["static"] },
      persistence: { state_file: "state/loop-verify.json" },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 2 },
      ...(withPolicy ? { policy: { approval_mode: "bypass" as const } } : {}),
      ...(provider
        ? ({ runtime: { provider } } as { runtime: { provider: string } })
        : {}),
    },
  };
}

const OPEN_PATTERN: FailurePattern = {
  pattern_id: "pattern-flaky-test",
  type: "verification_error",
  summary: "flaky test under load",
  signature: "sig-flaky",
  occurrence_count: 2,
  first_seen_at: new Date().toISOString(),
  last_seen_at: new Date().toISOString(),
  evidence_runs: ["run-old"],
  affected_loop_specs: ["loop-verify"],
  suggested_action: "proposal_required",
  status: "open",
};

async function withFixture(
  opts: {
    withPolicy: boolean;
    scripted: { tool: string; input: unknown }[];
    verifyRunFn: (input: VerifyRunInput) => Promise<VerifyRunResult>;
    seedPattern?: boolean;
    provider?: string;
    /** 种进 proposalStore 并推进到 published 的提案 (装配消费用)。 */
    proposals?: ImprovementProposal[];
    /** supervisor 进程永不发声 (adapter_policy 超时用例)。 */
    silent?: boolean;
  },
  fn: (ctx: {
    service: LoopRunService;
    controlPlane: ControlPlane;
    ledgerStore: RunLedgerStore;
    supervisor: VerifyFakeSupervisor;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-run-verify-"));
  try {
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
    });
    const failurePatternStore = new FailurePatternStore({ dataDir });
    if (opts.seedPattern) {
      await failurePatternStore.upsert(OPEN_PATTERN);
    }
    const proposalStore = new ProposalStore({ dataDir });
    await proposalStore.initialize();
    for (const proposal of opts.proposals ?? []) {
      await proposalStore.create({ ...proposal, status: "draft" });
      await proposalStore.transitionStatus(proposal.proposal_id, "shadow", {
        stage: "shadow",
        by: "worker",
      });
      await proposalStore.transitionStatus(proposal.proposal_id, "canary", {
        stage: "regression",
        by: "worker",
      });
      await proposalStore.transitionStatus(proposal.proposal_id, "approved", {
        by: "human",
      });
      await proposalStore.transitionStatus(proposal.proposal_id, "published", {
        stage: "publish",
        by: "human",
      });
    }
    const card = makeCard(opts.withPolicy, opts.provider);
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
    const supervisor = new VerifyFakeSupervisor(opts.scripted, opts.silent);
    const service = new LoopRunService({
      supervisor: supervisor as unknown as Supervisor,
      loopCardStore,
      runLedgerStore: ledgerStore,
      controlPlane,
      failurePatternStore,
      proposalStore,
      sleep: async () => {},
      verifyRunFn: opts.verifyRunFn as never,
      dataDir,
    });
    await fn({ service, controlPlane, ledgerStore, supervisor });
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

test("policy run: verification input carries permission/policy/runtime/failure-pattern evidence", async () => {
  let captured: VerifyRunInput | null = null;
  await withFixture(
    {
      withPolicy: true,
      scripted: [{ tool: "Write", input: { file_path: `${WS}/src/foo.ts` } }],
      seedPattern: true,
      verifyRunFn: async (input) => {
        captured = input;
        return {
          reports: [],
          judgment: PASSED_JUDGMENT,
          refs: {
            verification_input: "artifact://run/verification-input.json",
            verifier_runtime: "verifier-runtime://subprocess:static",
            verifier_report: "artifact://run/verifier-reports.json",
            judgment_report: "artifact://run/judgment-report.json",
          },
        };
      },
    },
    async ({ service, controlPlane, ledgerStore }) => {
      const summary = await service.startRun("loop-verify", "manual");
      const state = await waitForState(controlPlane, summary.run_id, [
        "complete",
      ]);
      assert.equal(state, "complete");

      assert.ok(captured, "verifyRun was called");
      const input = captured as unknown as VerifyRunInput;
      const runId = summary.run_id;
      assert.equal(input.turn, 1);
      // 02 §5 permission_event_refs：钩子裁决落盘并引用（bypass 自批准）
      assert.deepEqual(input.permissionEventRefs, [
        `artifact://${runId}/permission-events.json`,
      ]);
      // 02 §5 policy_intent_ref：引用 turn 1 的策略投影快照，不再写死哨兵
      assert.equal(
        input.policyIntentRef,
        `artifact://${runId}/policy-projection.json`,
      );
      // 02 §5 runtime_event_refs：轮内归一消息流落盘并引用
      assert.equal(
        input.runtimeEventsRef,
        `artifact://${runId}/runtime-events.jsonl`,
      );
      // 02 §5 executor_summary：标记块自述提取落盘并引用
      assert.equal(
        input.executorSummaryRef,
        `artifact://${runId}/executor-summary.md`,
      );
      // 02 §5 known_failure_patterns：失败模式账本 open 模式投影
      assert.deepEqual(input.knownFailurePatterns, ["pattern-flaky-test"]);

      // 证据 artifact 真实存在且内容正确
      const events = JSON.parse(
        (await ledgerStore.readArtifact(runId, "permission-events.json")) ?? "",
      );
      assert.equal(events.length, 1);
      assert.equal(events[0].decision, "bypass_used");
      assert.equal(events[0].tool, "Write");
      const runtimeEvents = await ledgerStore.readArtifact(
        runId,
        "runtime-events.jsonl",
      );
      assert.ok(runtimeEvents?.includes('"assistant"'));
      assert.ok(runtimeEvents?.includes('"result"'));
      const summaryArtifact = await ledgerStore.readArtifact(
        runId,
        "executor-summary.md",
      );
      assert.ok(summaryArtifact?.includes("- Done: scanned src/"));
      assert.ok(!summaryArtifact?.includes("Scope scanned"));
    },
  );
});

test("verification layer crash escalates to needs_human instead of silently completing", async () => {
  await withFixture(
    {
      withPolicy: false,
      scripted: [],
      verifyRunFn: async () => {
        throw new Error("verifier exploded");
      },
    },
    async ({ service, controlPlane, ledgerStore }) => {
      const summary = await service.startRun("loop-verify", "manual");
      const state = await waitForState(controlPlane, summary.run_id, [
        "needs_human",
      ]);
      assert.equal(state, "needs_human");

      // 崩溃证据落盘
      const errorArtifact = await ledgerStore.readArtifact(
        summary.run_id,
        "verification-error.json",
      );
      assert.ok(errorArtifact, "verification-error artifact written");
      assert.match(errorArtifact, /verifier exploded/);

      // 控制决策是 needs_human，理由经过 requires_human judgment
      const decisions = await ledgerStore.readDecisionEntries(summary.run_id);
      const control = decisions.find((d) => d.decision === "needs_human");
      assert.ok(control, "needs_human control decision ledgered");
      assert.match(control.reason, /requires human review/);
    },
  );
});

test("codex provider: ledger runtime block projects real adapter/mode/capability (02 §8.1)", async () => {
  await withFixture(
    {
      withPolicy: false,
      provider: "codex",
      scripted: [],
      verifyRunFn: async () => ({
        reports: [],
        judgment: PASSED_JUDGMENT,
        refs: {
          verification_input: "artifact://run/verification-input.json",
          verifier_runtime: "verifier-runtime://subprocess:static",
          verifier_report: "artifact://run/verifier-reports.json",
          judgment_report: "artifact://run/judgment-report.json",
        },
      }),
    },
    async ({ service, controlPlane, ledgerStore }) => {
      const summary = await service.startRun("loop-verify", "manual");
      const state = await waitForState(controlPlane, summary.run_id, [
        "complete",
      ]);
      assert.equal(state, "complete");

      const latest = await ledgerStore.readEntry(summary.run_id);
      // 不再是硬编码 claude / agent_sdk / graceful（06 偏差 #17：Codex
      // 无优雅 interrupt，应记 kill-only）
      assert.equal(latest?.runtime.adapter, "codex");
      assert.equal(latest?.runtime.mode, "exec");
      const snapshot = latest?.runtime.adapter_capability_snapshot ?? "";
      assert.match(snapshot, /realSdk\(app_server\)/);
      assert.match(snapshot, /interrupt=kill-only/);
    },
  );
});

function adapterProposal(
  id: string,
  adapterPolicy: Record<string, unknown>,
): ImprovementProposal {
  return {
    proposal_id: id,
    type: "runtime_adapter_proposal",
    source_patterns: ["fp-1"],
    summary: "adapter policy override",
    target: "loop-verify.adapter.timeout_config",
    expected_effect: "bounded turns",
    risk: "low",
    validation_plan: "shadow + regression",
    status: "draft",
    created_by: "human",
    payload: { adapter_policy: adapterPolicy },
    created_at: "2026-07-24T10:00:00.000Z",
  };
}

const PASSED_VERIFY = async (): Promise<VerifyRunResult> => ({
  reports: [],
  judgment: PASSED_JUDGMENT,
  refs: {
    verification_input: "artifact://run/verification-input.json",
    verifier_runtime: "verifier-runtime://subprocess:static",
    verifier_report: "artifact://run/verifier-reports.json",
    judgment_report: "artifact://run/judgment-report.json",
  },
});

test("adapter_policy: published proposal's model override reaches the adapter call (#13)", async () => {
  await withFixture(
    {
      withPolicy: false,
      scripted: [],
      verifyRunFn: PASSED_VERIFY,
      proposals: [
        adapterProposal("prop-model", { model: "claude-opus-override" }),
      ],
    },
    async ({ service, controlPlane, ledgerStore, supervisor }) => {
      const summary = await service.startRun("loop-verify", "manual");
      const state = await waitForState(controlPlane, summary.run_id, [
        "complete",
      ]);
      assert.equal(state, "complete");

      // executor turn 的 session settings 用了提案的 model 覆盖
      assert.equal(supervisor.settingsSeen[0]?.model, "claude-opus-override");
      // 账本能力快照记录 adapter_policy 实际生效
      const latest = await ledgerStore.readEntry(summary.run_id);
      assert.match(
        latest?.runtime.adapter_capability_snapshot ?? "",
        /adapterPolicy\[model=claude-opus-override\]/,
      );
    },
  );
});

test("adapter_policy: timeout_seconds kills a hanging turn as adapter timeout (#13)", async () => {
  await withFixture(
    {
      withPolicy: false,
      scripted: [],
      silent: true,
      verifyRunFn: PASSED_VERIFY,
      proposals: [adapterProposal("prop-timeout", { timeout_seconds: 0.05 })],
    },
    async ({ service, controlPlane, ledgerStore }) => {
      const summary = await service.startRun("loop-verify", "manual");
      // 进程永不发声 → 50ms 超时杀轮, 按 adapter 硬错误归因 failed,
      // 而不是无限等待
      const state = await waitForState(controlPlane, summary.run_id, [
        "failed",
      ]);
      assert.equal(state, "failed");

      const decisions = await ledgerStore.readDecisionEntries(summary.run_id);
      const failed = decisions.find((d) => d.decision === "failed");
      assert.ok(failed, "failed control decision ledgered");
      assert.match(failed.reason, /timeout/);
      assert.deepEqual(failed.failure_tags, ["runtime_blackbox_error"]);

      const latest = await ledgerStore.readEntry(summary.run_id);
      assert.match(
        latest?.runtime.adapter_capability_snapshot ?? "",
        /adapterPolicy\[timeout_seconds=0.05\]/,
      );
    },
  );
});

test("memory packet: open failure patterns are assembled into prompt and ledgered (02 §3)", async () => {
  await withFixture(
    {
      withPolicy: false,
      scripted: [],
      seedPattern: true,
      verifyRunFn: PASSED_VERIFY,
    },
    async ({ service, controlPlane, ledgerStore, supervisor }) => {
      const summary = await service.startRun("loop-verify", "manual");
      const state = await waitForState(controlPlane, summary.run_id, [
        "complete",
      ]);
      assert.equal(state, "complete");

      // executor prompt 携带失败模式账本摘要 (04 单写者表: assembly 读
      // failure-patterns)
      const executorPrompt = supervisor.textsSeen[0] ?? "";
      assert.match(executorPrompt, /Known failure patterns/);
      assert.match(executorPrompt, /pattern-flaky-test/);
      assert.match(executorPrompt, /flaky test under load/);

      // memory-packet.json 落盘, 账本 input_refs.memory_packet 不再恒 null
      const packet = await ledgerStore.readArtifact(
        summary.run_id,
        "memory-packet.json",
      );
      assert.ok(packet, "memory packet artifact written");
      assert.ok(packet.includes("pattern-flaky-test"));
      const latest = await ledgerStore.readEntry(summary.run_id);
      assert.equal(
        latest?.input_refs.memory_packet,
        `artifact://${summary.run_id}/memory-packet.json`,
      );
    },
  );
});

test("turn 1 lands runtime-input-bundle.json + prompt.md with structured execution contract (02 §3)", async () => {
  await withFixture(
    {
      withPolicy: false,
      scripted: [],
      verifyRunFn: PASSED_VERIFY,
    },
    async ({ service, controlPlane, ledgerStore }) => {
      const summary = await service.startRun("loop-verify", "manual");
      const state = await waitForState(controlPlane, summary.run_id, [
        "complete",
      ]);
      assert.equal(state, "complete");

      const bundle = JSON.parse(
        (await ledgerStore.readArtifact(
          summary.run_id,
          "runtime-input-bundle.json",
        )) ?? "",
      );
      assert.equal(bundle.turn, 1);
      assert.equal(bundle.execution_contract.scope.length, 1);
      assert.ok(Array.isArray(bundle.execution_contract.constraints));
      assert.deepEqual(bundle.native_invocation.adapter, "claude");
      assert.equal(bundle.native_invocation.bridge, "agent_sdk");
      assert.equal(bundle.observability.capture_stderr, false);
      assert.equal(bundle.policy_projection, "not_applicable");
      assert.ok(bundle.budget_remaining);
      assert.equal(
        bundle.context_injection.prompt_ref,
        `artifact://${summary.run_id}/prompt.md`,
      );
      // 主 prompt 文本落盘且与 bundle 引用一致
      const prompt = await ledgerStore.readArtifact(
        summary.run_id,
        "prompt.md",
      );
      assert.ok(prompt?.includes("Required output"));
    },
  );
});
