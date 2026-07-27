/**
 * worktree 隔离策略集成测试（spec: 02-schema契约.md §1 workspace.strategy）:
 *
 *  - strategy "worktree" 的 run 在 <dataDir>/worktrees/<loop>/<run> 下执行
 *    (executor cwd 被改写为 worktree 目录), 隔离证据落 workspace.json
 *    artifact 并引用进 turn 1 artifact_refs;
 *  - 创建期校验: POST /api/loops 带 worktree 策略但 workspace.path 缺失或
 *    不是 git 仓库 → 400 invalid_loop_card (不留到 run 启动才失败)。
 *
 * 真实路由 + stores + control-plane + run service + 真实 git; 仅
 * Supervisor 与验证层是 fake。
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { JudgmentReport, LoopCard, RunState } from "@yep-anywhere/shared";
import type { Hono } from "hono";
import { createLoopsRoutes } from "../routes/loops.js";
import type { Process } from "../supervisor/Process.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { IEventBus } from "../watcher/index.js";
import { ControlPlane } from "./control-plane/control-plane.js";
import { RunStateStore } from "./control-plane/run-state-store.js";
import { LoopRunService } from "./run-service.js";
import { LoopCardStore } from "./state/loop-card-store.js";
import { RunLedgerStore } from "./state/run-ledger-store.js";
import type { VerifyRunResult } from "./verification/verify-run.js";

const execFileAsync = promisify(execFile);

interface SupervisorCall {
  cwd: string;
  text: string;
}

/** Fake Supervisor: 记录 cwd 并立即成功。 */
class FakeSupervisor {
  readonly calls: SupervisorCall[] = [];

  async startSession(cwd: string, message: { text: string }): Promise<Process> {
    this.calls.push({ cwd, text: message.text });
    return {
      sessionId: "session-wt-1",
      subscribe: (listener: (event: unknown) => void) => {
        queueMicrotask(() => {
          listener({
            type: "message",
            message: {
              type: "result",
              subtype: "success",
              result: "turn report text",
              is_error: false,
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          });
        });
        return () => {};
      },
      terminate: () => {},
      abort: async () => {},
      respondToInput: () => {},
    } as unknown as Process;
  }
}

async function git(args: string[], cwd?: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function makeTempRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "yep-wt-it-repo-"));
  await git(["init"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  await writeFile(path.join(repo, "README.md"), "hello\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  return repo;
}

function makeCard(id: string, repoPath: string): LoopCard {
  return {
    loop: {
      id,
      trigger: { type: "manual" },
      workspace: { strategy: "worktree", path: repoPath },
      verification: { required: ["static"] },
      persistence: { state_file: `state/${id}.json` },
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

async function fakeVerify(): Promise<VerifyRunResult> {
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
}

interface Fixture {
  app: Hono;
  controlPlane: ControlPlane;
  supervisor: FakeSupervisor;
  ledgerStore: RunLedgerStore;
}

async function withFixture(fn: (ctx: Fixture) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "yep-wt-it-data-"));
  try {
    const loopCardStore = new LoopCardStore({ dataDir });
    await loopCardStore.initialize();
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const eventBus = {
      emit: () => {},
    } as unknown as IEventBus;
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
      eventBus,
    });
    const supervisor = new FakeSupervisor();
    const service = new LoopRunService({
      supervisor: supervisor as unknown as Supervisor,
      loopCardStore,
      runLedgerStore: ledgerStore,
      controlPlane,
      sleep: async () => {},
      verifyRunFn: fakeVerify as never,
      dataDir,
    });
    const app = createLoopsRoutes({
      loopCardStore,
      runService: service,
      controlPlane,
    });
    await fn({ app, controlPlane, supervisor, ledgerStore });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function waitForState(
  controlPlane: ControlPlane,
  runId: string,
  expected: RunState[],
  timeoutMs = 10_000,
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

test("worktree 策略: run 在隔离 worktree 中执行, workspace.json 落盘并被账本引用", async (t) => {
  if (!(await gitAvailable())) {
    t.skip("git not available");
    return;
  }
  const repo = await makeTempRepo();
  try {
    await withFixture(
      async ({ app, controlPlane, supervisor, ledgerStore }) => {
        const create = await app.request("/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(makeCard("loop-wt", repo)),
        });
        assert.equal(create.status, 201);

        const trigger = await app.request("/loop-wt/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        assert.equal(trigger.status, 201);
        const { run } = (await trigger.json()) as { run: { run_id: string } };
        await waitForState(controlPlane, run.run_id, ["complete"]);

        // executor cwd 被改写为 run 级 worktree 目录 (collector 会话不在
        // 此断言范围 — 按 prompt 文本区分角色, 与 pause 测试夹具同法)
        const executorCalls = supervisor.calls.filter(
          (call) => !call.text.includes("Collector input bundle"),
        );
        assert.equal(executorCalls.length, 1);
        const cwd = executorCalls[0]?.cwd ?? "";
        assert.ok(
          cwd.includes(path.join("worktrees", "loop-wt", run.run_id)),
          `cwd 应是 worktree 目录, 实际: ${cwd}`,
        );

        // 隔离证据 artifact: 原目录 / worktree 目录 / 分支 / 基线 SHA
        const evidenceJson = await ledgerStore.readArtifact(
          run.run_id,
          "workspace.json",
        );
        assert.ok(evidenceJson, "workspace.json 落盘");
        const evidence = JSON.parse(evidenceJson ?? "{}") as {
          strategy: string;
          origin_path: string;
          worktree_path: string;
          branch: string;
          base_sha: string;
        };
        assert.equal(evidence.strategy, "worktree");
        assert.equal(evidence.origin_path, repo);
        assert.equal(evidence.worktree_path, cwd);
        assert.equal(evidence.branch, `loop/${run.run_id}`);
        assert.ok(evidence.base_sha.length > 0);

        // 账本 artifact_refs 引用 workspace.json
        const entry = await ledgerStore.readEntry(run.run_id);
        assert.ok(
          entry?.artifact_refs.includes(
            `artifact://${run.run_id}/workspace.json`,
          ),
        );
      },
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("创建期校验: worktree 策略 + 非 git 路径 / 缺路径 → 400 invalid_loop_card", async () => {
  await withFixture(async ({ app }) => {
    const notRepo = await mkdtemp(path.join(tmpdir(), "yep-wt-notrepo-"));
    try {
      const bad1 = await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(makeCard("loop-bad-1", notRepo)),
      });
      assert.equal(bad1.status, 400);
      assert.equal(
        ((await bad1.json()) as { error: string }).error,
        "invalid_loop_card",
      );

      const missingPath = makeCard("loop-bad-2", "");
      const bad2 = await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(missingPath),
      });
      assert.equal(bad2.status, 400);
      assert.equal(
        ((await bad2.json()) as { error: string }).error,
        "invalid_loop_card",
      );
    } finally {
      await rm(notRepo, { recursive: true, force: true });
    }
  });
});
