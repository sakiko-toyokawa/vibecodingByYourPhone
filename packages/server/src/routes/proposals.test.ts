import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ImprovementProposal, LoopCard } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { LoopCardStore, ProposalStore } from "../loop/index.js";
import type { ControlPlane, LoopRunService } from "../loop/index.js";
import type { BusEvent } from "../watcher/EventBus.js";
import type { IEventBus } from "../watcher/IEventBus.js";
import { createLoopsRoutes } from "./loops.js";
import { createProposalsRoutes } from "./proposals.js";

const NOW = "2026-07-24T10:00:00.000Z";

function makeProposal(
  id: string,
  overrides: Partial<ImprovementProposal> = {},
): ImprovementProposal {
  return {
    proposal_id: id,
    type: "memory_packet_template_proposal",
    source_patterns: ["fp-1"],
    summary: "s",
    target: "loop-1.memory_packet_template",
    expected_effect: "e",
    risk: "low",
    validation_plan: "v",
    status: "draft",
    created_by: "worker",
    created_at: NOW,
    ...overrides,
  };
}

function makeCard(id: string): LoopCard {
  return {
    loop: {
      id,
      trigger: { type: "manual" },
      workspace: { strategy: "direct", path: "/tmp/target" },
      verification: { required: [] },
      persistence: { state_file: ".loop/STATE.md" },
      stop_rules: { max_turns: 3, max_time_minutes: 10, max_retries: 2 },
    },
  } as LoopCard;
}

class FakeEventBus implements IEventBus {
  readonly events: BusEvent[] = [];
  subscribe(): () => void {
    return () => {};
  }
  emit(event: BusEvent): void {
    this.events.push(event);
  }
  get subscriberCount(): number {
    return 0;
  }
}

interface Ctx {
  app: Hono;
  store: ProposalStore;
  eventBus: FakeEventBus;
}

async function withApp(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-proposal-routes-"));
  try {
    const store = new ProposalStore({ dataDir });
    await store.initialize();
    const loopCardStore = new LoopCardStore({ dataDir });
    await loopCardStore.initialize();
    await loopCardStore.createLoop(makeCard("loop-1"));
    const eventBus = new FakeEventBus();
    const app = new Hono();
    app.route(
      "/api/loops",
      createLoopsRoutes({ loopCardStore, proposalStore: store }),
    );
    app.route(
      "/api/proposals",
      createProposalsRoutes({ proposalStore: store, eventBus }),
    );
    await fn({ app, store, eventBus });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

function post(path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 推进到指定状态的捷径 (迁移合法性由 store 守卫, 测试只铺状态). */
async function advanceTo(
  store: ProposalStore,
  id: string,
  target: "canary" | "approved" | "published",
): Promise<void> {
  await store.transitionStatus(id, "shadow", { stage: "shadow", by: "worker" });
  await store.transitionStatus(id, "canary", {
    stage: "regression",
    by: "worker",
  });
  if (target === "canary") {
    return;
  }
  await store.transitionStatus(id, "approved", { by: "human" });
  if (target === "approved") {
    return;
  }
  await store.transitionStatus(id, "published", {
    stage: "publish",
    by: "human",
  });
}

// --- GET 详情 + history ---

test("POST /api/proposals — 人工创建: 201, created_by=human, status=draft (06 偏差 #25)", async () => {
  await withApp(async ({ app, store }) => {
    const res = await app.request(
      post("/api/proposals", {
        type: "memory_packet_template_proposal",
        summary: "inject retry-hint template",
        target: "loop-1.memory_packet_template",
        expected_effect: "fewer context_error recurrences",
        risk: "low",
        validation_plan: "shadow then canary on loop-1",
        payload: {
          memory_packet_template:
            "Always re-check assumptions before reporting.",
          canary_loops: ["loop-1"],
        },
      }),
    );
    assert.equal(res.status, 201);
    const body = (await res.json()) as { proposal: ImprovementProposal };
    assert.match(body.proposal.proposal_id, /^prop-/);
    assert.equal(body.proposal.created_by, "human");
    assert.equal(body.proposal.status, "draft");
    assert.equal(
      body.proposal.payload?.memory_packet_template,
      "Always re-check assumptions before reporting.",
    );
    // 落盘可检索 (后续由 worker pipeline 推进 draft→shadow→canary)
    assert.equal(
      store.get(body.proposal.proposal_id)?.proposal_id,
      body.proposal.proposal_id,
    );
  });
});

test("POST /api/proposals — 非法请求体 400 invalid_proposal", async () => {
  await withApp(async ({ app }) => {
    const res = await app.request(
      post("/api/proposals", { type: "memory_packet_template_proposal" }),
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid_proposal");
  });
});

// --- GET 详情 + history ---

test("GET /api/proposals/:id — 详情 + history; 未知 id 404", async () => {
  await withApp(async ({ app, store }) => {
    await store.create(makeProposal("p-1"));
    const missing = await app.request("/api/proposals/nope");
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "proposal_not_found");

    const res = await app.request("/api/proposals/p-1");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      proposal: ImprovementProposal;
      history: unknown[];
    };
    assert.equal(body.proposal.proposal_id, "p-1");
    assert.deepEqual(body.history, []);
  });
});

// --- approve ---

test("approve: canary → approved 200; draft 缺 eval 证据 409", async () => {
  await withApp(async ({ app, store }) => {
    await store.create(makeProposal("p-draft"));
    const draftRes = await app.request(
      post("/api/proposals/p-draft/approve", {}),
    );
    assert.equal(draftRes.status, 409);
    assert.equal((await draftRes.json()).error, "invalid_transition");

    await store.create(makeProposal("p-canary"));
    await advanceTo(store, "p-canary", "canary");
    const res = await app.request(
      post("/api/proposals/p-canary/approve", { feedback: "LGTM" }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { proposal: ImprovementProposal };
    assert.equal(body.proposal.status, "approved");
    const last = store.getHistory("p-canary").at(-1);
    assert.equal(last?.by, "human");
    assert.equal(last?.reason, "LGTM");
  });
});

test("元规则拒绝矩阵: worker 发起的元规则提案 approve 403 (人工发起的 200)", async () => {
  await withApp(async ({ app, store }) => {
    await store.create(
      makeProposal("p-meta-worker", {
        type: "eval_task_proposal",
        target: "loop-1.eval_regression_suite",
        created_by: "worker",
      }),
    );
    await advanceTo(store, "p-meta-worker", "canary");
    const res = await app.request(
      post("/api/proposals/p-meta-worker/approve", {}),
    );
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "meta_rule_requires_human");
    assert.equal(store.get("p-meta-worker")?.status, "canary");

    await store.create(
      makeProposal("p-meta-human", {
        type: "eval_task_proposal",
        target: "loop-1.eval_regression_suite",
        created_by: "human",
      }),
    );
    await advanceTo(store, "p-meta-human", "canary");
    const okRes = await app.request(
      post("/api/proposals/p-meta-human/approve", {}),
    );
    assert.equal(okRes.status, 200);
  });
});

// --- publish (仅人工) ---

test("publish: 无人类标记 / worker 标记一律 403; by=human 200 并广播 proposal-published", async () => {
  await withApp(async ({ app, store, eventBus }) => {
    await store.create(makeProposal("p-pub"));
    await advanceTo(store, "p-pub", "approved");

    // 无标记 (空 body)
    const noMarker = await app.request(post("/api/proposals/p-pub/publish"));
    assert.equal(noMarker.status, 403);
    assert.equal((await noMarker.json()).error, "human_required");
    // worker 标记
    const workerMarker = await app.request(
      post("/api/proposals/p-pub/publish", { by: "worker" }),
    );
    assert.equal(workerMarker.status, 403);
    assert.equal(store.get("p-pub")?.status, "approved");

    const res = await app.request(
      post("/api/proposals/p-pub/publish", { by: "human" }),
    );
    assert.equal(res.status, 200);
    assert.equal(
      ((await res.json()) as { proposal: ImprovementProposal }).proposal.status,
      "published",
    );
    const event = eventBus.events.find((e) => e.type === "proposal-published");
    assert.ok(event, "published 应广播 proposal-published (activity channel)");
    if (event?.type === "proposal-published") {
      assert.equal(event.proposal_id, "p-pub");
      assert.equal(event.loop_id, "loop-1");
      assert.equal(event.published_by, "human");
      assert.equal(event.from_status, "approved");
    }
  });
});

test("publish: 非 approved 状态 409; worker 发起的元规则提案 by=human 也 403", async () => {
  await withApp(async ({ app, store }) => {
    await store.create(makeProposal("p-state"));
    const res = await app.request(
      post("/api/proposals/p-state/publish", { by: "human" }),
    );
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, "invalid_transition");

    await store.create(
      makeProposal("p-meta", {
        type: "verification_rule_proposal",
        target: "verifier_rubric",
        created_by: "worker",
      }),
    );
    await advanceTo(store, "p-meta", "approved");
    const metaRes = await app.request(
      post("/api/proposals/p-meta/publish", { by: "human" }),
    );
    assert.equal(metaRes.status, 403);
    assert.equal((await metaRes.json()).error, "meta_rule_requires_human");
  });
});

// --- rollback ---

test("rollback: published → rolled_back 保留版本记录; 终态再回滚 409", async () => {
  await withApp(async ({ app, store }) => {
    await store.create(makeProposal("p-rb"));
    await advanceTo(store, "p-rb", "published");

    const res = await app.request(
      post("/api/proposals/p-rb/rollback", { reason: "指标变差" }),
    );
    assert.equal(res.status, 200);
    assert.equal(
      ((await res.json()) as { proposal: ImprovementProposal }).proposal.status,
      "rolled_back",
    );
    const history = store.getHistory("p-rb");
    assert.equal(history.at(-1)?.reason, "指标变差");
    assert.equal(history.length, 5); // 推进全程 + 回滚都在账本里

    const again = await app.request(post("/api/proposals/p-rb/rollback", {}));
    assert.equal(again.status, 409);
  });
});

// --- GET /api/loops/:id/proposals ---

test("GET /api/loops/:id/proposals — 按 loop 过滤 + status 过滤; 未知 loop 404", async () => {
  await withApp(async ({ app, store }) => {
    await store.create(makeProposal("p-l1", { target: "loop-1.x" }));
    await store.create(
      makeProposal("p-l1b", {
        target: "unrelated.target",
        status: "draft",
        payload: { canary_loops: ["loop-1"] },
        created_at: "2026-07-24T11:00:00.000Z",
      }),
    );
    await store.create(makeProposal("p-l2", { target: "loop-2.x" }));

    const res = await app.request("/api/loops/loop-1/proposals");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { proposals: ImprovementProposal[] };
    assert.deepEqual(
      body.proposals.map((p) => p.proposal_id),
      ["p-l1b", "p-l1"], // created_at 倒序
    );

    const missing = await app.request("/api/loops/nope/proposals");
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "loop_not_found");
  });
});

test("GET /api/loops/:id — current_run_state / last_run_summary 真实接线 (#16)", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-loops-detail-"));
  try {
    const loopCardStore = new LoopCardStore({ dataDir });
    await loopCardStore.initialize();
    await loopCardStore.createLoop(makeCard("loop-1"));
    await loopCardStore.createLoop(makeCard("loop-2"));

    const runState = {
      version: 2,
      goal_id: "intent-1",
      run_id: "run-7",
      state: "active",
      turn: 1,
      intent_version: 1,
      workspace_ref: "workspace://loop-1/run-7",
      last_judgment: null,
      pending_approval: null,
      created_at: NOW,
      updated_at: NOW,
    };
    const summary = {
      run_id: "run-7",
      loop_id: "loop-1",
      state: "active",
      source: "manual",
      created_at: NOW,
    };
    const app = new Hono();
    app.route(
      "/api/loops",
      createLoopsRoutes({
        loopCardStore,
        runService: {
          listRuns: async (loopId: string) =>
            loopId === "loop-1" ? [summary] : [],
        } as unknown as LoopRunService,
        controlPlane: {
          getRunState: async (loopId: string) =>
            loopId === "loop-1" ? runState : null,
        } as unknown as ControlPlane,
      }),
    );

    const res = await app.request("/api/loops/loop-1");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      current_run_state: { run_id: string; state: string } | null;
      last_run_summary: { run_id: string } | null;
    };
    assert.equal(body.current_run_state?.run_id, "run-7");
    assert.equal(body.current_run_state?.state, "active");
    assert.equal(body.last_run_summary?.run_id, "run-7");

    // 无 run 的 loop: 两个字段如实为 null
    const res2 = await app.request("/api/loops/loop-2");
    const body2 = (await res2.json()) as {
      current_run_state: unknown;
      last_run_summary: unknown;
    };
    assert.equal(body2.current_run_state, null);
    assert.equal(body2.last_run_summary, null);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
