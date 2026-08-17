import assert from "node:assert/strict";
import test from "node:test";
import { TargetAdapterRegistry } from "./registry.js";

const adapter = (targetType: string) => ({
  targetType,
  poll: async () => 0,
  handleWebhook: async () => ({}),
  toTargetState: () => "done" as const,
  fromTargetState: () => "closed",
});

test("TargetAdapterRegistry rejects duplicates and returns null for unknown types", () => {
  const registry = new TargetAdapterRegistry();
  registry.register(adapter("local_dir"));
  assert.equal(registry.get("missing"), null);
  assert.equal(registry.get("local_dir")?.targetType, "local_dir");
  assert.throws(
    () => registry.register(adapter("local_dir")),
    /already registered/,
  );
});

test("TargetAdapterRegistry rejects registrations after freeze", () => {
  const registry = new TargetAdapterRegistry();
  registry.freeze();
  assert.throws(() => registry.register(adapter("later")), /frozen/);
});
