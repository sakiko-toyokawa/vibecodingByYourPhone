/**
 * routes-003-proposal-approve-publish-rollback public tests
 *
 * Verify HTTP route behavior for proposal creation, approval, publishing,
 * rollback, and the loop-scoped proposal list.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ImprovementProposal } from "@yep-anywhere/shared";
import type { Hono } from "hono";
import { LoopCardStore } from "../../../../packages/server/src/loop/state/loop-card-store.js";
import { ProposalStore } from "../../../../packages/server/src/loop/state/proposal-store.js";
import { createLoopsRoutes } from "../../../../packages/server/src/routes/loops.js";
import { createProposalsRoutes } from "../../../../packages/server/src/routes/proposals.js";
import { createFakeEventBus } from "../../fixtures/fake-event-bus.js";
import { withTempDataDir } from "../../fixtures/temp-data-dir.js";

function makeProposalPayload(
  id: string,
  status: ImprovementProposal["status"],
  target = "loop-it.memory_packet_template",
  createdBy: ImprovementProposal["created_by"] = "human",
): ImprovementProposal {
  return {
    proposal_id: id,
    type: "memory_packet_template_proposal",
    source_patterns: [],
    summary: "test proposal",
    target,
    expected_effect: "better results",
    risk: "medium",
    validation_plan: "run evals",
    status,
    created_by: createdBy,
    created_at: new Date().toISOString(),
  };
}

interface Fixture {
  loopsApp: Hono;
  proposalsApp: Hono;
  proposalStore: ProposalStore;
}

async function withFixture(fn: (ctx: Fixture) => Promise<void>): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const loopCardStore = new LoopCardStore({ dataDir });
    await loopCardStore.initialize();
    await loopCardStore.createLoop({
      loop: {
        id: "loop-it",
        trigger: { type: "manual" },
        workspace: { strategy: "direct", path: "/tmp/routes-003-ws" },
      },
    });
    const proposalStore = new ProposalStore({ dataDir });
    await proposalStore.initialize();
    const { bus: eventBus } = createFakeEventBus();
    const loopsApp = createLoopsRoutes({
      loopCardStore,
      proposalStore,
    });
    const proposalsApp = createProposalsRoutes({
      proposalStore,
      eventBus,
    });
    await fn({ loopsApp, proposalsApp, proposalStore });
  });
}

test("POST /api/proposals creates a human proposal in draft status", async () => {
  await withFixture(async ({ proposalsApp }) => {
    const res = await proposalsApp.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "memory_packet_template_proposal",
        summary: "inject workspace rules",
        target: "loop-it.memory_packet_template",
        expected_effect: "fewer context errors",
        risk: "low",
        validation_plan: "eval on loop-it",
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { proposal: ImprovementProposal };
    assert.equal(body.proposal.status, "draft");
    assert.equal(body.proposal.created_by, "human");
    assert.equal(body.proposal.target, "loop-it.memory_packet_template");
  });
});

test("POST /api/proposals with invalid body returns 400 invalid_proposal", async () => {
  await withFixture(async ({ proposalsApp }) => {
    const res = await proposalsApp.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summary: "missing required fields" }),
    });
    assert.equal(res.status, 400);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "invalid_proposal",
    );
  });
});

test("POST /api/proposals/:id/approve moves canary proposal to approved", async () => {
  await withFixture(async ({ proposalsApp, proposalStore }) => {
    const created = await proposalStore.create(
      makeProposalPayload("prop-001", "draft"),
    );
    await proposalStore.transitionStatus(created.proposal_id, "shadow");
    await proposalStore.transitionStatus(created.proposal_id, "canary");

    const res = await proposalsApp.request(`/${created.proposal_id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feedback: "ready for publish" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { proposal: ImprovementProposal };
    assert.equal(body.proposal.status, "approved");

    const history = proposalStore.getHistory(created.proposal_id);
    assert.ok(history.some((h) => h.to === "approved"));
  });
});

test("POST /api/proposals/:id/publish requires explicit human marker", async () => {
  await withFixture(async ({ proposalsApp, proposalStore }) => {
    const created = await proposalStore.create(
      makeProposalPayload("prop-002", "draft"),
    );
    await proposalStore.transitionStatus(created.proposal_id, "shadow");
    await proposalStore.transitionStatus(created.proposal_id, "canary");
    await proposalStore.transitionStatus(created.proposal_id, "approved");

    const missing = await proposalsApp.request(
      `/${created.proposal_id}/publish`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assert.equal(missing.status, 403);
    assert.equal(
      ((await missing.json()) as { error: string }).error,
      "human_required",
    );

    const wrong = await proposalsApp.request(
      `/${created.proposal_id}/publish`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ by: "worker" }),
      },
    );
    assert.equal(wrong.status, 403);
    assert.equal(
      ((await wrong.json()) as { error: string }).error,
      "human_required",
    );

    const ok = await proposalsApp.request(`/${created.proposal_id}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ by: "human", feedback: "ship it" }),
    });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { proposal: ImprovementProposal };
    assert.equal(body.proposal.status, "published");
  });
});

test("POST /api/proposals/:id/rollback moves non-terminal proposal to rolled_back", async () => {
  await withFixture(async ({ proposalsApp, proposalStore }) => {
    const created = await proposalStore.create(
      makeProposalPayload("prop-003", "draft"),
    );
    await proposalStore.transitionStatus(created.proposal_id, "shadow");

    const res = await proposalsApp.request(`/${created.proposal_id}/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "does not help" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { proposal: ImprovementProposal };
    assert.equal(body.proposal.status, "rolled_back");

    const history = proposalStore.getHistory(created.proposal_id);
    assert.ok(history.some((h) => h.to === "rolled_back"));
  });
});

test("GET /api/loops/:id/proposals lists proposals scoped to that loop", async () => {
  await withFixture(async ({ loopsApp, proposalStore }) => {
    await proposalStore.create(
      makeProposalPayload(
        "prop-loop",
        "draft",
        "loop-it.memory_packet_template",
      ),
    );
    await proposalStore.create(
      makeProposalPayload(
        "prop-other",
        "draft",
        "loop-other.memory_packet_template",
      ),
    );
    await proposalStore.create({
      ...makeProposalPayload("prop-canary", "draft", "loop-other.policy"),
      payload: { canary_loops: ["loop-it"] },
    });

    const res = await loopsApp.request("/loop-it/proposals");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { proposals: ImprovementProposal[] };
    const ids = body.proposals.map((p) => p.proposal_id).sort();
    assert.deepEqual(ids, ["prop-canary", "prop-loop"]);
  });
});

test("GET /api/loops/:id/proposals returns 404 for unknown loop", async () => {
  await withFixture(async ({ loopsApp }) => {
    const res = await loopsApp.request("/loop-ghost/proposals");
    assert.equal(res.status, 404);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "loop_not_found",
    );
  });
});
