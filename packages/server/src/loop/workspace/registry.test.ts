import assert from "node:assert/strict";
import test from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import { WorkspaceResolverRegistry } from "./registry.js";

const card = { loop: { id: "demo" } } as LoopCard;
const resolver = (id: string) => ({
  id,
  matches: () => true,
  resolve: async (value: LoopCard) => ({ card: value, handled: true }),
});

test("WorkspaceResolverRegistry selects the first matching resolver", () => {
  const registry = new WorkspaceResolverRegistry();
  registry.register(resolver("first"));
  registry.register(resolver("second"));
  assert.equal(registry.find(card)?.id, "first");
});

test("WorkspaceResolverRegistry rejects duplicates and freezes", () => {
  const registry = new WorkspaceResolverRegistry();
  registry.register(resolver("same"));
  assert.throws(() => registry.register(resolver("same")), /already registered/);
  registry.freeze();
  assert.throws(() => registry.register(resolver("later")), /frozen/);
});
