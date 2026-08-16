import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { LoopProposalLifecycleService } from "../loop/proposal/lifecycle-service.js";
import { LoopProposalStore } from "../loop/proposal/loop-proposal-store.js";
import {
  LOOP_PROPOSAL_BEGIN,
  LOOP_PROPOSAL_END,
} from "../loop/proposal/loop-proposal.js";
import { LoopCardStore } from "../loop/state/loop-card-store.js";
import { createLoopProposalsRoutes } from "./loop-proposals.js";

function parentCard(): LoopCard {
  return {
    loop: {
      id: "parent-loop",
      trigger: { type: "schedule", cron: "0 9 * * *" },
      workspace: { strategy: "direct" },
      verification: { required: ["static"] },
      persistence: { state_file: ".loop/STATE.md" },
      stop_rules: { max_turns: 5, max_time_minutes: 60, max_retries: 1 },
      can_propose_loops: true,
    },
  } as LoopCard;
}

function proposalText(childId: string): string {
  const card = {
    loop: {
      id: childId,
      trigger: { type: "manual" },
      workspace: { strategy: "direct" },
      verification: { required: ["static"] },
      persistence: { state_file: ".loop/STATE.md" },
      stop_rules: { max_turns: 3, max_time_minutes: 30, max_retries: 1 },
      handoff: { task: "专项跟进" },
    },
  };
  return [
    LOOP_PROPOSAL_BEGIN,
    JSON.stringify({ card, reason: "值得专项跟进" }),
    LOOP_PROPOSAL_END,
  ].join("\n");
}

interface RouteFixture {
  dataDir: string;
  app: Hono;
  loopCardStore: LoopCardStore;
  proposalStore: LoopProposalStore;
  lifecycle: LoopProposalLifecycleService;
}

async function makeRouteFixture(): Promise<RouteFixture> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-loop-proposal-routes-"));
  const loopCardStore = new LoopCardStore({ dataDir });
  await loopCardStore.initialize();
  await loopCardStore.createLoop(parentCard());
  const proposalStore = new LoopProposalStore({ dataDir });
  await proposalStore.initialize();
  const lifecycle = new LoopProposalLifecycleService({
    proposalStore,
    loopCardStore,
  });
  const app = new Hono().route(
    "/loop-proposals",
    createLoopProposalsRoutes({
      loopProposalStore: proposalStore,
      loopProposalLifecycle: lifecycle,
    }),
  );
  return { dataDir, app, loopCardStore, proposalStore, lifecycle };
}

test("GET /loop-proposals lists proposals with optional state filter", async () => {
  const fixture = await makeRouteFixture();
  try {
    await fixture.lifecycle.registerLoopProposal(
      "parent-loop",
      "run-1",
      proposalText("child-loop"),
    );
    const all = await fixture.app.request("/loop-proposals");
    assert.equal(all.status, 200);
    const allBody = (await all.json()) as { proposals: unknown[] };
    assert.equal(allBody.proposals.length, 1);

    const pending = await fixture.app.request(
      "/loop-proposals?state=pending_approval",
    );
    assert.equal(
      ((await pending.json()) as { proposals: unknown[] }).proposals.length,
      1,
    );
    const approved = await fixture.app.request(
      "/loop-proposals?state=approved",
    );
    assert.equal(
      ((await approved.json()) as { proposals: unknown[] }).proposals.length,
      0,
    );
    const bad = await fixture.app.request("/loop-proposals?state=nope");
    assert.equal(bad.status, 400);
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("POST /loop-proposals/:id/approve follows 404/409 semantics", async () => {
  const fixture = await makeRouteFixture();
  try {
    // 404 proposal_not_found
    const missing = await fixture.app.request("/loop-proposals/nope/approve", {
      method: "POST",
    });
    assert.equal(missing.status, 404);
    assert.equal(
      ((await missing.json()) as { error: string }).error,
      "proposal_not_found",
    );

    const proposal = await fixture.lifecycle.registerLoopProposal(
      "parent-loop",
      "run-1",
      proposalText("child-loop"),
    );
    assert.ok(proposal);

    // 批准成功：用钳制后的 card 创建 loop 并记 created loop_id
    const ok = await fixture.app.request(
      `/loop-proposals/${proposal.proposal_id}/approve`,
      { method: "POST" },
    );
    assert.equal(ok.status, 200);
    const okBody = (await ok.json()) as {
      proposal: { state: string; created_loop_id: string };
      loop_id: string;
    };
    assert.equal(okBody.proposal.state, "approved");
    assert.equal(okBody.loop_id, "child-loop");
    assert.ok(fixture.loopCardStore.getLoop("child-loop"));

    // 409 invalid_state（已 approved）
    const again = await fixture.app.request(
      `/loop-proposals/${proposal.proposal_id}/approve`,
      { method: "POST" },
    );
    assert.equal(again.status, 409);
    assert.equal(
      ((await again.json()) as { error: string }).error,
      "invalid_state",
    );

    // 409 loop_id_conflict（card id 已被占用）
    const conflict = await fixture.lifecycle.registerLoopProposal(
      "parent-loop",
      "run-2",
      proposalText("child-loop"),
    );
    assert.ok(conflict);
    const conflicted = await fixture.app.request(
      `/loop-proposals/${conflict.proposal_id}/approve`,
      { method: "POST" },
    );
    assert.equal(conflicted.status, 409);
    assert.equal(
      ((await conflicted.json()) as { error: string }).error,
      "loop_id_conflict",
    );
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("POST /loop-proposals/:id/reject follows 400/404/409 semantics", async () => {
  const fixture = await makeRouteFixture();
  try {
    // 400 invalid_request（reason 类型非法）
    const badBody = await fixture.app.request("/loop-proposals/x/reject", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: 123 }),
    });
    assert.equal(badBody.status, 400);
    assert.equal(
      ((await badBody.json()) as { error: string }).error,
      "invalid_request",
    );

    // 404 proposal_not_found
    const missing = await fixture.app.request("/loop-proposals/nope/reject", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "r" }),
    });
    assert.equal(missing.status, 404);

    const proposal = await fixture.lifecycle.registerLoopProposal(
      "parent-loop",
      "run-1",
      proposalText("child-loop"),
    );
    assert.ok(proposal);

    // 拒绝成功，reason 落账
    const ok = await fixture.app.request(
      `/loop-proposals/${proposal.proposal_id}/reject`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "预算不允许" }),
      },
    );
    assert.equal(ok.status, 200);
    const okBody = (await ok.json()) as {
      proposal: { state: string; rejection_reason: string };
    };
    assert.equal(okBody.proposal.state, "rejected");
    assert.equal(okBody.proposal.rejection_reason, "预算不允许");

    // 409 invalid_state（已 rejected）
    const again = await fixture.app.request(
      `/loop-proposals/${proposal.proposal_id}/reject`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "again" }),
      },
    );
    assert.equal(again.status, 409);
    assert.equal(
      ((await again.json()) as { error: string }).error,
      "invalid_state",
    );
  } finally {
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});
