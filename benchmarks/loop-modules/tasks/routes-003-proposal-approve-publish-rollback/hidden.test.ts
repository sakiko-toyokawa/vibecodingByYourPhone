/**
 * routes-003-proposal-approve-publish-rollback hidden tests
 *
 * Additional edge cases for proposal route behavior.
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
  type: ImprovementProposal["type"] = "memory_packet_template_proposal",
): ImprovementProposal {
  return {
    proposal_id: id,
    type,
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

test("GET /api/proposals/:id returns proposal and history; 404 for unknown", async () => {
  await withFixture(async ({ proposalsApp, proposalStore }) => {
    const created = await proposalStore.create(
      makeProposalPayload("prop-detail", "draft"),
    );

    const res = await proposalsApp.request(`/${created.proposal_id}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      proposal: ImprovementProposal;
      history: unknown[];
    };
    assert.equal(body.proposal.proposal_id, created.proposal_id);
    assert.ok(Array.isArray(body.history));

    const missing = await proposalsApp.request("/prop-ghost");
    assert.equal(missing.status, 404);
    assert.equal(
      ((await missing.json()) as { error: string }).error,
      "proposal_not_found",
    );
  });
});

test("POST approve returns 404 for unknown proposal", async () => {
  await withFixture(async ({ proposalsApp }) => {
    const res = await proposalsApp.request("/prop-ghost/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "proposal_not_found",
    );
  });
});

test("POST approve returns 409 invalid_transition from draft", async () => {
  await withFixture(async ({ proposalsApp, proposalStore }) => {
    const created = await proposalStore.create(
      makeProposalPayload("prop-draft", "draft"),
    );
    const res = await proposalsApp.request(`/${created.proposal_id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 409);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "invalid_transition",
    );
  });
});

test("POST publish returns 409 invalid_transition from canary", async () => {
  await withFixture(async ({ proposalsApp, proposalStore }) => {
    const created = await proposalStore.create(
      makeProposalPayload("prop-canary2", "draft"),
    );
    await proposalStore.transitionStatus(created.proposal_id, "shadow");
    await proposalStore.transitionStatus(created.proposal_id, "canary");

    const res = await proposalsApp.request(`/${created.proposal_id}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ by: "human" }),
    });
    assert.equal(res.status, 409);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "invalid_transition",
    );
  });
});

test("POST rollback returns 409 invalid_transition for terminal rejected status", async () => {
  await withFixture(async ({ proposalsApp, proposalStore }) => {
    const created = await proposalStore.create(
      makeProposalPayload("prop-rejected", "draft"),
    );
    await proposalStore.transitionStatus(created.proposal_id, "rejected");

    const res = await proposalsApp.request(`/${created.proposal_id}/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 409);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "invalid_transition",
    );
  });
});

test("Worker-created meta-rule proposal cannot be approved or published", async () => {
  await withFixture(async ({ proposalsApp, proposalStore }) => {
    const created = await proposalStore.create(
      makeProposalPayload(
        "prop-meta",
        "draft",
        "loop-it.pipeline_rule",
        "worker",
        "memory_packet_template_proposal",
      ),
    );
    await proposalStore.transitionStatus(created.proposal_id, "shadow");
    await proposalStore.transitionStatus(created.proposal_id, "canary");

    const approve = await proposalsApp.request(
      `/${created.proposal_id}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assert.equal(approve.status, 403);
    assert.equal(
      ((await approve.json()) as { error: string }).error,
      "meta_rule_requires_human",
    );

    const publish = await proposalsApp.request(
      `/${created.proposal_id}/publish`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ by: "human" }),
      },
    );
    assert.equal(publish.status, 403);
    assert.equal(
      ((await publish.json()) as { error: string }).error,
      "meta_rule_requires_human",
    );
  });
});

test("GET /api/loops/:id/proposals status filter is honored", async () => {
  await withFixture(async ({ loopsApp, proposalStore }) => {
    await proposalStore.create(
      makeProposalPayload("prop-a", "draft", "loop-it.memory"),
    );
    const b = await proposalStore.create(
      makeProposalPayload("prop-b", "draft", "loop-it.memory"),
    );
    await proposalStore.transitionStatus(b.proposal_id, "rejected");

    const res = await loopsApp.request("/loop-it/proposals?status=draft");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { proposals: ImprovementProposal[] };
    assert.equal(body.proposals.length, 1);
    assert.equal(body.proposals[0]?.proposal_id, "prop-a");
  });
});
