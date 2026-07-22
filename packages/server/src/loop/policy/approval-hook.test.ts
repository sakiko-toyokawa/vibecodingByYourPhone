/**
 * approval-hook.ts 测试（05 阶段 2：bypass 自批准 + 全量审计）。
 *
 * 覆盖：
 *  - 自批准审计记录形状（工具名、关键参数、判定理由、bypass_used、
 *    policy_refs、确定性 decision_id）；
 *  - 硬闸门：拒绝 + 升级收集 + policy_blocked 审计（bypass 下仍被拦）；
 *  - 审计落账失败 fail-closed（无法审计的自批准不成立）。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DecisionEntry, PolicyProfile } from "@yep-anywhere/shared";
import { RunLedgerStore } from "../state/run-ledger-store.js";
import {
  type PolicyEscalation,
  createLoopToolApprovalHook,
} from "./approval-hook.js";

const WS = "/workspace/project";

const PROFILE: PolicyProfile = {
  policy_profile: "loop_bypass",
  approval_mode: "bypass",
  risk_rules: {
    low: "auto",
    medium: "auto_if_in_workspace",
    high: "review_or_policy",
    critical: "human_required",
  },
  hard_gates: [
    "merge",
    "deploy",
    "delete",
    "publish",
    "bill",
    "notify",
    "close",
  ],
  bypass_scope: {
    allow_workspace_write: true,
    allow_local_commands: true,
  },
};

async function withStore(
  fn: (ctx: {
    store: RunLedgerStore;
    escalations: PolicyEscalation[];
    hook: ReturnType<typeof createLoopToolApprovalHook>;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-policy-hook-"));
  try {
    const store = new RunLedgerStore({ dataDir });
    const escalations: PolicyEscalation[] = [];
    const hook = createLoopToolApprovalHook({
      profile: PROFILE,
      runId: "run-hook-1",
      loopId: "loop-hook",
      turn: 1,
      workspacePath: WS,
      store,
      escalations,
    });
    await fn({ store, escalations, hook });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("bypass self-approval: allow + bypass_used audit entry shape", async () => {
  await withStore(async ({ store, hook }) => {
    const result = await hook("Write", {
      file_path: `${WS}/src/foo.ts`,
      content: "x",
    });
    assert.deepEqual(result, { behavior: "allow" });

    const entries = await store.readDecisionEntries("run-hook-1");
    assert.equal(entries.length, 1);
    const audit = entries[0] as DecisionEntry;
    // 审计记录形状：决策类型 / 工具名 / 动作与风险 / 关键参数 / 判定理由
    assert.equal(audit.decision, "bypass_used");
    assert.equal(audit.run_id, "run-hook-1");
    assert.equal(audit.loop_id, "loop-hook");
    assert.match(audit.decision_id, /^decision-run-hook-1-t1-bypass_used-1$/);
    assert.match(audit.reason, /tool=Write/);
    assert.match(audit.reason, /action=write/);
    assert.match(audit.reason, /risk=medium/);
    assert.match(audit.reason, /src\/foo\.ts/); // 关键参数（路径摘要）
    assert.match(audit.reason, /auto_if_in_workspace/); // 判定理由
    assert.deepEqual(audit.policy_refs, ["policy://loop_bypass"]);
    assert.equal(audit.next_action, "none");
    assert.ok(audit.created_at);
  });
});

test("every self-approval gets its own audit entry (deterministic seq ids)", async () => {
  await withStore(async ({ store, hook }) => {
    await hook("Read", {});
    await hook("Bash", { command: "pnpm test" });
    await hook("Write", { file_path: `${WS}/a.ts` });

    const entries = await store.readDecisionEntries("run-hook-1");
    assert.equal(entries.length, 3);
    assert.deepEqual(
      entries.map((e) => e.decision_id),
      [
        "decision-run-hook-1-t1-bypass_used-1",
        "decision-run-hook-1-t1-bypass_used-2",
        "decision-run-hook-1-t1-bypass_used-3",
      ],
    );
    assert.ok(entries.every((e) => e.decision === "bypass_used"));
  });
});

test("hard gate under bypass: denied + escalation collected + policy_blocked audit", async () => {
  await withStore(async ({ store, escalations, hook }) => {
    const result = await hook("Bash", { command: "git merge feature" });
    assert.equal(result.behavior, "deny");
    assert.match(result.message ?? "", /hard gate 'merge'/);
    assert.match(result.message ?? "", /escalated for human review/);

    // 升级收集（run-service 在 turn 结束后升级 needs_human）
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0]?.action, "merge");
    assert.equal(escalations[0]?.policyRef, "policy://loop_bypass");

    const entries = await store.readDecisionEntries("run-hook-1");
    assert.equal(entries.length, 1);
    const audit = entries[0] as DecisionEntry;
    assert.equal(audit.decision, "policy_blocked");
    assert.equal(audit.next_action, "escalated_to_needs_human");
    assert.match(audit.reason, /tool=Bash/);
    assert.match(audit.reason, /git merge feature/);
    assert.deepEqual(audit.policy_refs, ["policy://loop_bypass"]);
  });
});

test("audit write failure is fail-closed (self-approval requires audit)", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-policy-hook-"));
  try {
    const store = new RunLedgerStore({ dataDir });
    store.appendDecisionEntry = async () => {
      throw new Error("disk full");
    };
    const hook = createLoopToolApprovalHook({
      profile: PROFILE,
      runId: "run-hook-2",
      loopId: "loop-hook",
      turn: 1,
      workspacePath: WS,
      store,
      escalations: [],
    });
    const result = await hook("Write", { file_path: `${WS}/a.ts` });
    assert.equal(result.behavior, "deny");
    assert.match(result.message ?? "", /fail-closed/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("manual profile denies mutations without audit entries", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-policy-hook-"));
  try {
    const store = new RunLedgerStore({ dataDir });
    const hook = createLoopToolApprovalHook({
      profile: { ...PROFILE, approval_mode: "manual" },
      runId: "run-hook-3",
      loopId: "loop-hook",
      turn: 1,
      workspacePath: WS,
      store,
      escalations: [],
    });
    const result = await hook("Write", { file_path: `${WS}/a.ts` });
    assert.equal(result.behavior, "deny");
    assert.match(result.message ?? "", /manual approval mode/);
    const entries = await store.readDecisionEntries("run-hook-3");
    assert.equal(entries.length, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
