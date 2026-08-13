/**
 * verify-run.ts 测试（02 §5 VerificationInputBundle 的 maker→checker
 * 证据接线 + 02 §8.1 per-turn 产物命名）。
 *
 * 覆盖：
 *  - 验证输入包含真实证据引用：diff / runtime events（runtime_event_refs
 *    + structured_output）/ permission_event_refs / policy_intent_ref /
 *    known_failure_patterns —— 不再是恒 null / 恒空 / 哨兵；
 *  - turn > 1 的验证产物带 `-turn<N>` 后缀（retry 不覆盖上一轮证据），
 *    turn 1 保持规范名（兼容阶段 0/1）。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import { buildIntentContract } from "../contract/intent-contract.js";
import { RunLedgerStore } from "../state/run-ledger-store.js";
import { verificationArtifactName, verifyRun } from "./verify-run.js";

function makeCard(workspacePath: string): LoopCard {
  return {
    loop: {
      id: "loop-verify",
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: workspacePath },
      verification: { required: ["static"] },
      persistence: { state_file: "state/loop-verify.json" },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 2 },
    },
  };
}

async function withStore(
  fn: (ctx: {
    store: RunLedgerStore;
    workspace: string;
    runId: string;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-verify-run-"));
  const workspace = await mkdtemp(join(tmpdir(), "yep-verify-ws-"));
  try {
    await fn({
      store: new RunLedgerStore({ dataDir }),
      workspace,
      runId: "run-verify-1",
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
    await rm(workspace, { recursive: true, force: true, maxRetries: 5 });
  }
}

test("verification input carries real maker evidence refs (02 §5)", async () => {
  await withStore(async ({ store, workspace, runId }) => {
    const card = makeCard(workspace);
    const contract = buildIntentContract(card, { runId, source: "manual" });

    const result = await verifyRun(
      {
        card,
        contract,
        runId,
        workspacePath: workspace,
        exitStatus: 0,
        stdoutRef: `artifact://${runId}/stdout.log`,
        diffRef: `artifact://${runId}/diff.patch`,
        runtimeEventsRef: `artifact://${runId}/runtime-events.jsonl`,
        executorSummaryRef: `artifact://${runId}/executor-summary.md`,
        permissionEventRefs: [`artifact://${runId}/permission-events.json`],
        policyIntentRef: `artifact://${runId}/policy-projection.json`,
        knownFailurePatterns: ["pattern-flaky-test"],
      },
      { store },
    );

    assert.equal(
      result.refs.verification_input,
      `artifact://${runId}/verification-input.json`,
    );
    const bundle = JSON.parse(
      (await store.readArtifact(runId, "verification-input.json")) ?? "",
    );
    assert.equal(bundle.evidence_refs.diff, `artifact://${runId}/diff.patch`);
    assert.equal(
      bundle.evidence_refs.structured_output,
      `artifact://${runId}/runtime-events.jsonl`,
    );
    assert.equal(
      bundle.evidence_refs.executor_summary,
      `artifact://${runId}/executor-summary.md`,
    );
    assert.deepEqual(bundle.runtime_event_refs, [
      `artifact://${runId}/runtime-events.jsonl`,
    ]);
    assert.deepEqual(bundle.permission_event_refs, [
      `artifact://${runId}/permission-events.json`,
    ]);
    assert.equal(
      bundle.policy_intent_ref,
      `artifact://${runId}/policy-projection.json`,
    );
    assert.deepEqual(bundle.known_failure_patterns, ["pattern-flaky-test"]);
  });
});

test("turn > 1 verification artifacts are named per-turn (02 §8.1)", async () => {
  await withStore(async ({ store, workspace, runId }) => {
    const card = makeCard(workspace);
    const contract = buildIntentContract(card, { runId, source: "manual" });

    const result = await verifyRun(
      {
        card,
        contract,
        runId,
        turn: 2,
        workspacePath: workspace,
        exitStatus: 0,
        stdoutRef: `artifact://${runId}/stdout-turn2.log`,
      },
      { store },
    );

    assert.equal(
      result.refs.verification_input,
      `artifact://${runId}/verification-input-turn2.json`,
    );
    assert.equal(
      result.refs.judgment_report,
      `artifact://${runId}/judgment-report-turn2.json`,
    );
    assert.equal(
      result.refs.verifier_report,
      `artifact://${runId}/verifier-reports-turn2.json`,
    );
    // per-turn 文件真实存在；规范名（turn 1）文件不存在
    const bundle = JSON.parse(
      (await store.readArtifact(runId, "verification-input-turn2.json")) ?? "",
    );
    assert.equal(bundle.exit_status, 0);
    await store.readArtifact(runId, "verifier-report-static-turn2.json");
    assert.equal(
      await store.readArtifact(runId, "verification-input.json"),
      undefined,
    );
    // 缺省输入退化为显式空/哨兵，不伪造
    assert.equal(bundle.evidence_refs.diff, null);
    assert.equal(bundle.evidence_refs.executor_summary, null);
    assert.deepEqual(bundle.permission_event_refs, []);
    assert.equal(bundle.policy_intent_ref, "not_applicable");
    assert.deepEqual(bundle.known_failure_patterns, []);
  });
});

test("verificationArtifactName: turn 1 keeps canonical names", () => {
  assert.equal(
    verificationArtifactName("judgment-report.json", 1),
    "judgment-report.json",
  );
  assert.equal(
    verificationArtifactName("judgment-report.json", 3),
    "judgment-report-turn3.json",
  );
  assert.equal(
    verificationArtifactName("verifier-report-static.json", 2),
    "verifier-report-static-turn2.json",
  );
});

test("短路规则: static 硬失败后 runtime 段跳过且注明原因 (四段验证模型.md)", async () => {
  await withStore(async ({ store, workspace, runId }) => {
    const node = `"${process.execPath}"`;
    const card = makeCard(workspace);
    card.loop.verification = {
      required: ["static", "runtime"],
      commands: {
        static: [`${node} -e "process.exit(1)"`],
        runtime: [`${node} -e "process.exit(0)"`],
      },
    };
    const contract = buildIntentContract(card, { runId, source: "manual" });

    const result = await verifyRun(
      {
        card,
        contract,
        runId,
        workspacePath: workspace,
        exitStatus: 0,
        stdoutRef: null,
      },
      { store },
    );
    // 只有 static 报告参与聚合; runtime 段短路, 聚合结论不变 (failed)
    assert.equal(result.reports.length, 1);
    assert.equal(result.reports[0]?.verifier_phase, "static");
    assert.equal(result.judgment.overall, "failed");
    const skipped = JSON.parse(
      (await store.readArtifact(runId, "verifier-report-runtime.json")) ?? "",
    );
    assert.equal(skipped.status, "not_applicable");
    assert.match(skipped.note, /short-circuited/);
    // runtime 的命令没有真正执行 (无 per-command 输出日志)
    assert.equal(
      await store.readArtifact(runId, "verifier-output-runtime-1.log"),
      undefined,
    );

    // 对照: static 通过时 runtime 正常执行
    card.loop.verification = {
      required: ["static", "runtime"],
      commands: {
        static: [`${node} -e "process.exit(0)"`],
        runtime: [`${node} -e "process.exit(0)"`],
      },
    };
    const result2 = await verifyRun(
      {
        card,
        contract,
        runId,
        workspacePath: workspace,
        exitStatus: 0,
        stdoutRef: null,
      },
      { store },
    );
    assert.equal(result2.reports.length, 2);
  });
});

test("skipExecutablePhases: non-code subtask skips static/runtime without unverified", async () => {
  await withStore(async ({ store, workspace, runId }) => {
    const card = makeCard(workspace);
    card.loop.verification = {
      required: ["static", "runtime"],
      commands: {
        static: ['node -e "process.exit(1)"'],
        runtime: ['node -e "process.exit(1)"'],
      },
    };
    const contract = buildIntentContract(card, { runId, source: "manual" });

    const result = await verifyRun(
      {
        card,
        contract,
        runId,
        workspacePath: workspace,
        exitStatus: 0,
        stdoutRef: null,
        skipExecutablePhases: [
          {
            phase: "static",
            reason: "non-code subtask, no clone materialized",
          },
          {
            phase: "runtime",
            reason: "non-code subtask, no clone materialized",
          },
        ],
      },
      { store },
    );

    assert.equal(result.reports.length, 0);
    assert.equal(result.judgment.overall, "passed");
    for (const phase of ["static", "runtime"] as const) {
      const report = JSON.parse(
        (await store.readArtifact(runId, `verifier-report-${phase}.json`)) ??
          "",
      );
      assert.equal(report.status, "not_applicable");
      assert.match(report.note, /non-code subtask/);
    }
    assert.equal(
      await store.readArtifact(runId, "verifier-output-runtime-1.log"),
      undefined,
    );
  });
});

test("P0: rule/structural 走策略管线; rule 無規則 inconclusive, structural 無 checker unverified", async () => {
  await withStore(async ({ store, workspace, runId }) => {
    const card = makeCard(workspace);
    card.loop.verification = { required: ["rule", "structural"] };
    const contract = buildIntentContract(card, { runId, source: "manual" });

    const result = await verifyRun(
      {
        card,
        contract,
        runId,
        workspacePath: workspace,
        exitStatus: 0,
        stdoutRef: null,
      },
      { store },
    );

    // 两段都进入策略管线并产出真实 VerifierReport (不是 not_applicable 占位)
    assert.equal(result.reports.length, 2);
    assert.deepEqual(
      result.reports.map((r) => r.verifier_phase),
      ["rule", "structural"],
    );
    assert.deepEqual(
      result.reports.map((r) => r.status),
      ["inconclusive", "unverified"],
    );
    assert.ok(
      result.reports.every((report) => report.recommendation === "escalate"),
    );
    // unverified 參與聚合且不綠燈: overall 不再是 passed
    assert.equal(result.judgment.overall, "unverified");
    assert.equal(result.judgment.next_action, "escalate");
    // per-phase artifact 落盘; P2 起 rule 由 RuleBasedStrategy 承載 ——
    // 無規則可跑是配置缺口 (inconclusive); P3 起 structural 由
    // StructuralStrategy 承載, 空 workspace 無適用 checker 是 unverified。
    const ruleReport = JSON.parse(
      (await store.readArtifact(runId, "verifier-report-rule.json")) ?? "",
    );
    assert.equal(ruleReport.verifier_phase, "rule");
    assert.match(ruleReport.unresolved_risks[0] ?? "", /沒有任何規則可執行/);
    const structuralReport = JSON.parse(
      (await store.readArtifact(runId, "verifier-report-structural.json")) ??
        "",
    );
    assert.match(structuralReport.unresolved_risks[0] ?? "", /無適用 checker/);
  });
});

test("P0: rule 段硬失败时 structural/review 短路 (与 static/runtime 同逻辑)", async () => {
  await withStore(async ({ store, workspace, runId }) => {
    const card = makeCard(workspace);
    card.loop.verification = { required: ["rule", "structural", "review"] };
    const contract = buildIntentContract(card, { runId, source: "manual" });

    // 注入一个 rule 段必失败的策略选择器, 验证新 phase 复用短路规则
    const failingSelector = (async () => ({
      name: "failing-rule",
      verify: async () => ({
        verifier_phase: "rule" as const,
        status: "failed" as const,
        evidence_refs: [] as string[],
        unresolved_risks: ["rule check failed"],
        recommendation: "retry" as const,
        confidence: 0.9,
        requires_human: false,
      }),
    })) as unknown as NonNullable<
      Parameters<typeof verifyRun>[1]["selectStrategy"]
    >;

    const result = await verifyRun(
      {
        card,
        contract,
        runId,
        workspacePath: workspace,
        exitStatus: 0,
        stdoutRef: null,
      },
      { store, selectStrategy: failingSelector },
    );

    assert.equal(result.reports.length, 1);
    assert.equal(result.reports[0]?.verifier_phase, "rule");
    assert.equal(result.judgment.overall, "failed");
    // structural / review 被短路为 not_applicable 占位
    const structural = JSON.parse(
      (await store.readArtifact(runId, "verifier-report-structural.json")) ??
        "",
    );
    assert.equal(structural.status, "not_applicable");
    assert.match(structural.note, /short-circuited/);
    const review = JSON.parse(
      (await store.readArtifact(runId, "verifier-report-review.json")) ?? "",
    );
    assert.equal(review.status, "not_applicable");
  });
});

test("review 段真实报告参与聚合, requires_human 透传不再被丢弃 (#12)", async () => {
  await withStore(async ({ store, workspace, runId }) => {
    const card = makeCard(workspace);
    card.loop.verification = { required: ["review"] };
    const contract = buildIntentContract(card, { runId, source: "manual" });

    const result = await verifyRun(
      {
        card,
        contract,
        runId,
        workspacePath: workspace,
        exitStatus: 0,
        stdoutRef: null,
        reviewReport: {
          verifier_phase: "review",
          status: "inconclusive",
          evidence_refs: [`artifact://${runId}/collector-report.json`],
          unresolved_risks: [
            "collector did not complete with a successful result",
          ],
          recommendation: "escalate",
          confidence: 0.2,
          requires_human: true,
        },
      },
      { store },
    );

    assert.equal(result.reports.length, 1);
    assert.equal(result.reports[0]?.verifier_phase, "review");
    // 02 §6: 人工透传优先级最高 —— collector 的 requires_human 生效
    assert.equal(result.judgment.requires_human, true);
    assert.notEqual(result.judgment.next_action, "complete");
    // 真报告落盘 (不是 not_applicable 占位)
    const review = JSON.parse(
      (await store.readArtifact(runId, "verifier-report-review.json")) ?? "",
    );
    assert.equal(review.status, "inconclusive");
    assert.equal(review.requires_human, true);
  });
});

test("P4: runReviewAgent 接管 review 段, agent 報告參與聚合", async () => {
  await withStore(async ({ store, workspace, runId }) => {
    const card = makeCard(workspace);
    card.loop.verification = { required: ["static", "review"] };
    const contract = buildIntentContract(card, { runId, source: "manual" });

    let agentSawPriorReports = 0;
    const result = await verifyRun(
      {
        card,
        contract,
        runId,
        workspacePath: workspace,
        exitStatus: 0,
        stdoutRef: null,
      },
      {
        store,
        runReviewAgent: async (agentCtx) => {
          agentSawPriorReports = agentCtx.priorReports.length;
          return {
            verifier_phase: "review",
            status: "failed",
            evidence_refs: [`artifact://${runId}/verifier-agent-output.log`],
            unresolved_risks: ["L4: 需求對齊不足"],
            recommendation: "retry",
            confidence: 0.8,
            requires_human: false,
            score: 0.55,
          };
        },
      },
    );

    // static (unverified, 無命令) + review (agent) 兩份報告
    assert.equal(result.reports.length, 2);
    assert.equal(agentSawPriorReports, 1);
    assert.equal(result.judgment.overall, "failed");
    // unverified 層會讓鏈路不能自動 retry：review 判 failed，但 static
    // 語言未驗證，整體仍要 escalate 給人工確認。
    assert.equal(result.judgment.next_action, "escalate");
    const review = JSON.parse(
      (await store.readArtifact(runId, "verifier-report-review.json")) ?? "",
    );
    assert.equal(review.status, "failed");
    assert.equal(review.score, 0.55);
  });
});

test("P4: 下層硬失敗短路時不呼叫 runReviewAgent (省 L4 成本)", async () => {
  await withStore(async ({ store, workspace, runId }) => {
    const node = `"${process.execPath}"`;
    const card = makeCard(workspace);
    card.loop.verification = {
      required: ["static", "review"],
      commands: { static: [`${node} -e "process.exit(1)"`] },
    };
    const contract = buildIntentContract(card, { runId, source: "manual" });

    let agentCalled = false;
    const result = await verifyRun(
      {
        card,
        contract,
        runId,
        workspacePath: workspace,
        exitStatus: 0,
        stdoutRef: null,
      },
      {
        store,
        runReviewAgent: async () => {
          agentCalled = true;
          return {
            verifier_phase: "review",
            status: "passed",
            evidence_refs: [],
            unresolved_risks: [],
            recommendation: "stop",
            confidence: 0.9,
            requires_human: false,
          };
        },
      },
    );

    assert.equal(agentCalled, false);
    assert.equal(result.reports.length, 1);
    assert.equal(result.judgment.overall, "failed");
    const review = JSON.parse(
      (await store.readArtifact(runId, "verifier-report-review.json")) ?? "",
    );
    assert.equal(review.status, "not_applicable");
    assert.match(review.note, /short-circuited/);
  });
});

test("interaction 段由 runner 接管並參與聚合", async () => {
  await withStore(async ({ store, workspace, runId }) => {
    const card = makeCard(workspace);
    card.loop.verification = {
      required: ["static", "interaction"],
      interaction: { enabled: true, url: "http://localhost:3400" },
    };
    const contract = buildIntentContract(card, { runId, source: "manual" });

    let interactionSawPriorReports = 0;
    const result = await verifyRun(
      {
        card,
        contract,
        runId,
        workspacePath: workspace,
        exitStatus: 0,
        stdoutRef: null,
      },
      {
        store,
        runInteractionAgent: async (interactionCtx) => {
          interactionSawPriorReports = interactionCtx.priorReports.length;
          return {
            verifier_phase: "interaction",
            status: "passed",
            evidence_refs: [`artifact://${runId}/interaction-output.log`],
            unresolved_risks: [],
            recommendation: "stop",
            confidence: 0.9,
            requires_human: false,
          };
        },
      },
    );

    assert.equal(interactionSawPriorReports, 1);
    assert.equal(result.reports.length, 2);
    assert.equal(result.reports[1]?.verifier_phase, "interaction");
    assert.equal(result.judgment.overall, "unverified");
    const interaction = JSON.parse(
      (await store.readArtifact(runId, "verifier-report-interaction.json")) ??
        "",
    );
    assert.equal(interaction.status, "passed");
  });
});

test("下層硬失敗短路時不呼叫 interaction runner", async () => {
  await withStore(async ({ store, workspace, runId }) => {
    const node = `"${process.execPath}"`;
    const card = makeCard(workspace);
    card.loop.verification = {
      required: ["static", "interaction", "review"],
      commands: { static: [`${node} -e "process.exit(1)"`] },
      interaction: { enabled: true, url: "http://localhost:3400" },
    };
    const contract = buildIntentContract(card, { runId, source: "manual" });

    let interactionCalled = false;
    const result = await verifyRun(
      {
        card,
        contract,
        runId,
        workspacePath: workspace,
        exitStatus: 0,
        stdoutRef: null,
      },
      {
        store,
        runInteractionAgent: async () => {
          interactionCalled = true;
          return {
            verifier_phase: "interaction",
            status: "passed",
            evidence_refs: [],
            unresolved_risks: [],
            recommendation: "stop",
            confidence: 0.9,
            requires_human: false,
          };
        },
      },
    );

    assert.equal(interactionCalled, false);
    assert.equal(result.reports.length, 1);
    assert.equal(result.judgment.overall, "failed");
    const interaction = JSON.parse(
      (await store.readArtifact(runId, "verifier-report-interaction.json")) ??
        "",
    );
    assert.equal(interaction.status, "not_applicable");
    assert.match(interaction.note, /short-circuited/);
  });
});
