import assert from "node:assert/strict";
import test from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import { createBuiltinGateRegistry } from "./builtins.js";
import type { GateContext } from "./registry.js";

function cardOf(loop: Record<string, unknown>): LoopCard {
  return { loop: { id: "loop-1", ...loop } } as LoopCard;
}

function ctxOf(overrides: Partial<GateContext> = {}): GateContext {
  return {
    loopId: "loop-1",
    runId: "run-1",
    card: cardOf({ discovery: { source: "github_prompt" } }),
    hasRelation: false,
    deps: {},
    ...overrides,
  };
}

function makeLifecycles() {
  const calls: string[] = [];
  const relationLifecycle = {
    registerGithubPrPublish: async () => {
      calls.push("pr");
      return { relation_id: "rel-1" };
    },
    registerGithubIssueProposal: async () => {
      calls.push("issue");
      return { relation_id: "rel-2" };
    },
  };
  const loopProposalLifecycle = {
    registerLoopProposal: async () => {
      calls.push("loop");
      return null;
    },
  };
  return { calls, relationLifecycle, loopProposalLifecycle };
}

test("builtin relation gates only enable for github_prompt cards", () => {
  const { relationLifecycle } = makeLifecycles();
  const registry = createBuiltinGateRegistry(relationLifecycle as never);
  const kinds = (card: LoopCard) => registry.forCard(card).map((g) => g.kind);
  assert.deepEqual(kinds(cardOf({ discovery: { source: "github_prompt" } })), [
    "pr_publish",
    "issue_proposal",
  ]);
  assert.deepEqual(kinds(cardOf({})), []);
});

test("publish gates skip maintenance runs (hasRelation guard)", async () => {
  const { calls, relationLifecycle } = makeLifecycles();
  const registry = createBuiltinGateRegistry(relationLifecycle as never);
  const gates = registry.forCard(ctxOf().card);
  for (const gate of gates) {
    assert.equal(
      await gate.onRunCompleted(ctxOf({ hasRelation: true }), "x"),
      false,
    );
  }
  assert.deepEqual(calls, []);
});

test("publish gates report consumption for the exclusive group", async () => {
  const { calls, relationLifecycle } = makeLifecycles();
  const registry = createBuiltinGateRegistry(relationLifecycle as never);
  const gates = registry.forCard(ctxOf().card);
  const [prGate, issueGate] = gates;
  assert.equal(prGate?.exclusiveGroup, "github-publish");
  assert.equal(issueGate?.exclusiveGroup, "github-publish");
  assert.ok(prGate);
  assert.equal(await prGate.onRunCompleted(ctxOf(), "x"), true);
  assert.deepEqual(calls, ["pr"]);
});

test("loop proposal gate teaches the exact marker syntax", () => {
  const { relationLifecycle, loopProposalLifecycle } = makeLifecycles();
  const registry = createBuiltinGateRegistry(
    relationLifecycle as never,
    loopProposalLifecycle as never,
  );
  const gate = registry
    .forCard(cardOf({ can_propose_loops: true }))
    .find((item) => item.kind === "loop_proposal");
  assert.ok(gate);
  const lines = gate.promptLines?.() ?? [];
  // 回归守卫：教学必须包含精确标记与 JSON 示例，阉割版会让 agent
  // 产不出可解析的提案块（2026-08-16 E2E 验证过的行为）。
  assert.ok(lines.some((line) => line.includes("<<<LOOP-PROPOSAL>>>")));
  assert.ok(lines.some((line) => line.includes("<<<END-LOOP-PROPOSAL>>>")));
  assert.ok(lines.some((line) => line.includes('"reason"')));
  // 未授权的卡不教也不收
  assert.equal(
    registry.forCard(cardOf({})).some((item) => item.kind === "loop_proposal"),
    false,
  );
});
