import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  ImprovementProposal,
  LearningEvent,
  LoopCard,
} from "@yep-anywhere/shared";
import { EvalRunner } from "../../../../packages/server/src/loop/learning/eval-runner.js";
import {
  ProposalPipeline,
  isMetaRuleProposal,
} from "../../../../packages/server/src/loop/learning/pipeline.js";
import { LearningWorker } from "../../../../packages/server/src/loop/learning/worker.js";
import { FailurePatternStore } from "../../../../packages/server/src/loop/state/failure-pattern-store.js";
import { LearningEventStore } from "../../../../packages/server/src/loop/state/learning-event-store.js";
import { LoopCardStore } from "../../../../packages/server/src/loop/state/loop-card-store.js";
import { ProposalStore } from "../../../../packages/server/src/loop/state/proposal-store.js";
import { RunLedgerStore } from "../../../../packages/server/src/loop/state/run-ledger-store.js";

const NOW = "2026-07-24T10:00:00.000Z";

function makeProposal(
  id: string,
  overrides: Partial<ImprovementProposal> = {},
): ImprovementProposal {
  return {
    proposal_id: id,
    type: "memory_packet_template_proposal",
    source_patterns: ["fp-1"],
    summary: "摘要规则",
    target: "loop-1.memory_packet_template",
    expected_effect: "减少 context_error",
    risk: "low",
    validation_plan: "shadow + regression + canary",
    status: "draft",
    created_by: "worker",
    created_at: NOW,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<LearningEvent> = {}): LearningEvent {
  return {
    event_id: "learn-evt-1",
    run_id: "run-1",
    loop_id: "loop-1",
    decision: "failed",
    judgment_ref: "not_available",
    ledger_refs: ["ledger://run-1"],
    failure_tags: ["tool_error"],
    created_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  };
}

test("isMetaRuleProposal 识别元规则类型与 target", () => {
  assert.ok(
    isMetaRuleProposal(makeProposal("m1", { type: "eval_task_proposal" })),
  );
  assert.ok(
    isMetaRuleProposal(
      makeProposal("m2", { type: "verification_rule_proposal" }),
    ),
  );
  assert.ok(
    isMetaRuleProposal(
      makeProposal("m3", { target: "release_pipeline.stages" }),
    ),
  );
  assert.ok(
    isMetaRuleProposal(makeProposal("m4", { target: "verifier_rubric" })),
  );
  assert.ok(
    !isMetaRuleProposal(
      makeProposal("m5", { target: "loop-1.memory_packet_template" }),
    ),
  );
  assert.ok(
    !isMetaRuleProposal(makeProposal("m6", { target: "adapter.tool_config" })),
  );
});

test("worker 元规则提案被稳定阻挡，不会意外进入管线", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-meta-stable-"));
  try {
    const store = new ProposalStore({ dataDir });
    await store.initialize();
    const loopCardStore = new LoopCardStore({ dataDir });
    await loopCardStore.initialize();
    const evalRunner = new EvalRunner({
      dataDir,
      now: () => new Date(NOW),
    });
    const pipeline = new ProposalPipeline({
      proposalStore: store,
      evalRunner,
      loopCardStore,
    });

    await store.create(
      makeProposal("prop-stable", {
        type: "eval_task_proposal",
        target: "loop-1.eval_regression_suite",
        created_by: "worker",
      }),
    );

    for (let i = 0; i < 5; i++) {
      await pipeline.advanceEligible();
    }
    assert.equal(store.get("prop-stable")?.status, "draft");
    assert.equal(store.getHistory("prop-stable").length, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("golden tasks: open failure pattern 同步为 eval 集 command case", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-golden-task-"));
  try {
    const card: LoopCard = {
      loop: {
        id: "loop-1",
        trigger: { type: "manual" },
        workspace: { strategy: "direct", path: "/tmp/golden-ws" },
        verification: {
          required: ["static"],
          commands: { static: ["pnpm lint"] },
        },
        persistence: { state_file: ".loop/STATE.md" },
        stop_rules: { max_turns: 3, max_time_minutes: 10, max_retries: 2 },
      },
    };
    const loopCardStore = {
      getLoop: (id: string) =>
        id === "loop-1"
          ? {
              id,
              card,
              created_at: "2026-07-01T00:00:00.000Z",
              updated_at: "2026-07-01T00:00:00.000Z",
              archived: false,
            }
          : undefined,
    } as LoopCardStore;

    const eventStore = new LearningEventStore({ dataDir });
    const patternStore = new FailurePatternStore({ dataDir });
    const evalRunner = new EvalRunner({ dataDir });
    const worker = new LearningWorker(
      {
        learningEventStore: eventStore,
        failurePatternStore: patternStore,
        proposalStore: new ProposalStore({ dataDir }),
        runLedgerStore: new RunLedgerStore({ dataDir }),
        loopCardStore,
        evalRunner,
      },
      { now: () => new Date("2026-07-23T12:00:00.000Z") },
    );

    for (const runId of ["run-1", "run-2"]) {
      await eventStore.appendEvent(
        makeEvent({ event_id: `e-${runId}`, run_id: runId }),
      );
    }
    await worker.tick();

    const pattern = patternStore.list()[0];
    assert.ok(pattern, "应生成 failure pattern");
    assert.equal(pattern.status, "open");

    const cases = await evalRunner.loadCases();
    const golden = cases.find(
      (c) => c.case_id === `golden-${pattern.pattern_id}`,
    );
    assert.ok(golden, "应生成 golden case");
    assert.equal(golden.kind, "command");
    assert.equal(golden.command, "pnpm");
    assert.deepEqual(golden.args, ["lint"]);
    assert.equal(golden.expect, "fail");
    assert.equal(golden.category, "tool_error");
    assert.equal(golden.loop_id, "loop-1");
    assert.equal(golden.workspace, "/tmp/golden-ws");

    // 只增不改：再次 tick 不重复入集
    const before = cases.length;
    await worker.tick();
    assert.equal((await evalRunner.loadCases()).length, before);

    worker.stop();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
