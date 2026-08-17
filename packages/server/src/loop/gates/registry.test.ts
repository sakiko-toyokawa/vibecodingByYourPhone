import assert from "node:assert/strict";
import test from "node:test";
import type { LoopCard } from "@yep-anywhere/shared";
import { GateRegistry } from "./registry.js";

const card = { loop: { id: "test" } } as LoopCard;
const gate = (kind: string) => ({
  kind,
  enabledFor: () => true,
  onRunCompleted: async () => false,
});

test("GateRegistry preserves order and filters", () => {
  const registry = new GateRegistry();
  registry.register(gate("first"));
  registry.register({ ...gate("disabled"), enabledFor: () => false });
  registry.register(gate("second"));
  assert.deepEqual(
    registry.forCard(card).map((item) => item.kind),
    ["first", "second"],
  );
});

test("GateRegistry rejects duplicate kinds", () => {
  const registry = new GateRegistry();
  registry.register(gate("same"));
  assert.throws(() => registry.register(gate("same")), /already registered/);
});
