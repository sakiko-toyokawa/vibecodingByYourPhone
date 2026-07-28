/**
 * direct 策略验证期间工作区稳定性标注的测试 (docs/plans/
 * loop-spec-gap-fix-plan.md backlog "过渡方案 (更便宜)"):
 *
 *  - helper 单测: 非 git 目录快照为 null; 快照比对口径 (HEAD/status);
 *  - 集成: 验证期间工作区被改动且本轮未判过 → judgment evidence 含
 *    `workspace_unstable_during_verification` 标注, judgment-report.json
 *    同步改写; 无变动 / 验证通过即使有变动 → 无标注; 非 git 工作区 →
 *    机制跳过不报错。
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
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
import {
  WORKSPACE_UNSTABLE_ANNOTATION,
  captureWorkspaceSnapshot,
  workspaceSnapshotChanged,
} from "./verification/workspace-stability.js";

const execFileAsync = promisify(execFile);

const SESSION_ID = "session-stability-1";

const FAILED_JUDGMENT: JudgmentReport = {
  overall: "failed",
  next_action: "escalate",
  retryable: false,
  requires_human: false,
  evidence: ["artifact://run/verifier-reports.json"],
  unresolved_risks: ["typecheck errors"],
};

const PASSED_JUDGMENT: JudgmentReport = {
  overall: "passed",
  next_action: "complete",
  retryable: false,
  requires_human: false,
  evidence: [],
  unresolved_risks: [],
};

const VERIFY_REFS = {
  verification_input: "artifact://run/verification-input.json",
  verifier_runtime: "verifier-runtime://subprocess:static",
  verifier_report: "artifact://run/verifier-reports.json",
  judgment_report: "artifact://run/judgment-report.json",
};

/** Fake Supervisor: 立即交付一轮成功结果 (执行侧永远 ok, 变量只在验证)。 */
class StabilityFakeSupervisor {
  async startSession(
    _cwd: string,
    _message: { text: string },
    _mode?: PermissionMode,
    _settings?: { toolApprovalHook?: ToolApprovalHook },
  ): Promise<Process> {
    return {
      sessionId: SESSION_ID,
      subscribe: (listener: (event: unknown) => void) => {
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
              result: "done",
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

/** 造一个带一次提交的临时 git 仓库作为工作区。 */
async function makeGitWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yep-stability-ws-"));
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
  });
  await execFileAsync("git", ["config", "user.name", "test"], { cwd: dir });
  await writeFile(join(dir, "seed.txt"), "seed\n");
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

function makeCard(workspacePath: string): LoopCard {
  return {
    loop: {
      id: "loop-stability",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: workspacePath },
      verification: { required: ["static"] },
      persistence: { state_file: "state/loop-stability.json" },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 2 },
    },
  };
}

async function withFixture(
  opts: {
    workspacePath: string;
    judgment: JudgmentReport;
    /** verifier 运行期间对工作区的干扰 (模拟用户/其他进程并发改动)。 */
    mutateDuringVerify?: (workspacePath: string) => Promise<void>;
  },
  fn: (ctx: {
    service: LoopRunService;
    controlPlane: ControlPlane;
    ledgerStore: RunLedgerStore;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-stability-data-"));
  try {
    const ledgerStore = new RunLedgerStore({ dataDir });
    const stateStore = new RunStateStore({ dataDir });
    const controlPlane = new ControlPlane({
      runStateStore: stateStore,
      runLedgerStore: ledgerStore,
    });
    const card = makeCard(opts.workspacePath);
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
      supervisor: new StabilityFakeSupervisor() as unknown as Supervisor,
      loopCardStore,
      runLedgerStore: ledgerStore,
      controlPlane,
      sleep: async () => {},
      verifyRunFn: (async () => {
        // 快照已在 verify 调用前取好; 此处模拟验证期间工作区被改动。
        await opts.mutateDuringVerify?.(opts.workspacePath);
        return {
          reports: [],
          judgment: opts.judgment,
          refs: VERIFY_REFS,
        } satisfies VerifyRunResult;
      }) as never,
      dataDir,
    });
    await fn({ service, controlPlane, ledgerStore });
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

/** 验证期间新增未跟踪文件: git status --porcelain 输出变化 (HEAD 不动)。 */
async function addUntrackedFile(workspacePath: string): Promise<void> {
  await writeFile(join(workspacePath, "concurrent-edit.txt"), "noise\n");
}

// --- helper 单测 ---

test("captureWorkspaceSnapshot: 非 git 目录返回 null (机制跳过, 不报错)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yep-stability-nongit-"));
  try {
    assert.equal(await captureWorkspaceSnapshot(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("captureWorkspaceSnapshot/workspaceSnapshotChanged: git 仓库快照与比对口径", async () => {
  const dir = await makeGitWorkspace();
  try {
    const before = await captureWorkspaceSnapshot(dir);
    assert.ok(before, "git 仓库应取到快照");
    assert.ok(before.head.length > 0);
    // 无变动 → 不比出差异
    const same = await captureWorkspaceSnapshot(dir);
    assert.ok(same);
    assert.equal(workspaceSnapshotChanged(before, same), false);
    // 新增未跟踪文件 → status 变化
    await addUntrackedFile(dir);
    const dirty = await captureWorkspaceSnapshot(dir);
    assert.ok(dirty);
    assert.equal(workspaceSnapshotChanged(before, dirty), true);
    // HEAD 移动也算变动
    assert.equal(
      workspaceSnapshotChanged(before, { ...before, head: "0".repeat(40) }),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

// --- run-service 集成 ---

test("direct: 验证期间工作区被改动 + 验证未判过 → evidence 标注并改写 judgment-report.json", async () => {
  const ws = await makeGitWorkspace();
  try {
    await withFixture(
      {
        workspacePath: ws,
        judgment: FAILED_JUDGMENT,
        mutateDuringVerify: addUntrackedFile,
      },
      async ({ service, controlPlane, ledgerStore }) => {
        const summary = await service.startRun("loop-stability", "manual");
        // failed + 不可重试 → 升级 needs_human (单轮收尾)
        const state = await waitForState(controlPlane, summary.run_id, [
          "needs_human",
        ]);
        assert.equal(state, "needs_human");

        const report = await ledgerStore.readArtifact(
          summary.run_id,
          "judgment-report.json",
        );
        assert.ok(report, "judgment-report.json 已同步改写");
        const judgment = JSON.parse(report) as JudgmentReport;
        assert.ok(
          judgment.evidence.includes(WORKSPACE_UNSTABLE_ANNOTATION),
          `evidence 应含稳定性标注, 实际: ${JSON.stringify(judgment.evidence)}`,
        );
        // 口径: 只标注, verdict 语义不变
        assert.equal(judgment.overall, "failed");
      },
    );
  } finally {
    await rm(ws, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("direct: 验证期间工作区无变动 → 无标注", async () => {
  const ws = await makeGitWorkspace();
  try {
    await withFixture(
      { workspacePath: ws, judgment: FAILED_JUDGMENT },
      async ({ service, controlPlane, ledgerStore }) => {
        const summary = await service.startRun("loop-stability", "manual");
        await waitForState(controlPlane, summary.run_id, ["needs_human"]);
        const report = await ledgerStore.readArtifact(
          summary.run_id,
          "judgment-report.json",
        );
        assert.ok(report);
        const judgment = JSON.parse(report) as JudgmentReport;
        assert.equal(
          judgment.evidence.includes(WORKSPACE_UNSTABLE_ANNOTATION),
          false,
        );
      },
    );
  } finally {
    await rm(ws, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("direct: 验证通过即使工作区有变动 → 无标注 (避免噪音)", async () => {
  const ws = await makeGitWorkspace();
  try {
    await withFixture(
      {
        workspacePath: ws,
        judgment: PASSED_JUDGMENT,
        mutateDuringVerify: addUntrackedFile,
      },
      async ({ service, controlPlane, ledgerStore }) => {
        const summary = await service.startRun("loop-stability", "manual");
        await waitForState(controlPlane, summary.run_id, ["complete"]);
        const report = await ledgerStore.readArtifact(
          summary.run_id,
          "judgment-report.json",
        );
        assert.ok(report);
        const judgment = JSON.parse(report) as JudgmentReport;
        assert.equal(
          judgment.evidence.includes(WORKSPACE_UNSTABLE_ANNOTATION),
          false,
        );
      },
    );
  } finally {
    await rm(ws, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("direct: 非 git 工作区 → 机制跳过不报错, 无标注", async () => {
  const ws = await mkdtemp(join(tmpdir(), "yep-stability-nongit-ws-"));
  try {
    await withFixture(
      {
        workspacePath: ws,
        judgment: FAILED_JUDGMENT,
        mutateDuringVerify: addUntrackedFile,
      },
      async ({ service, controlPlane, ledgerStore }) => {
        const summary = await service.startRun("loop-stability", "manual");
        // 不报错, 正常走到终态
        await waitForState(controlPlane, summary.run_id, ["needs_human"]);
        const report = await ledgerStore.readArtifact(
          summary.run_id,
          "judgment-report.json",
        );
        assert.ok(report);
        const judgment = JSON.parse(report) as JudgmentReport;
        assert.equal(
          judgment.evidence.includes(WORKSPACE_UNSTABLE_ANNOTATION),
          false,
        );
      },
    );
  } finally {
    await rm(ws, { recursive: true, force: true, maxRetries: 5 });
  }
});
