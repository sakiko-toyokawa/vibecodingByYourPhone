import { describe, expect, it } from "vitest";
import {
  type DagOrderable,
  needsReorder,
  orderByParentChain,
} from "../src/dag.js";

describe("dag", () => {
  describe("needsReorder", () => {
    it("returns false for empty array", () => {
      expect(needsReorder([])).toBe(false);
    });

    it("returns false for single item", () => {
      expect(needsReorder([{ id: "a", parentUuid: null }])).toBe(false);
    });

    it("returns false when items are in correct order", () => {
      const items: DagOrderable[] = [
        { id: "a", parentUuid: null },
        { id: "b", parentUuid: "a" },
        { id: "c", parentUuid: "b" },
      ];
      expect(needsReorder(items)).toBe(false);
    });

    it("returns true when parent comes after child", () => {
      const items: DagOrderable[] = [
        { id: "b", parentUuid: "a" }, // parent "a" not seen yet
        { id: "a", parentUuid: null },
      ];
      expect(needsReorder(items)).toBe(true);
    });

    it("returns true when items are in reverse order", () => {
      const items: DagOrderable[] = [
        { id: "c", parentUuid: "b" },
        { id: "b", parentUuid: "a" },
        { id: "a", parentUuid: null },
      ];
      expect(needsReorder(items)).toBe(true);
    });

    it("handles items without parentUuid as roots", () => {
      const items: DagOrderable[] = [
        { id: "a" }, // no parentUuid = root
        { id: "b", parentUuid: "a" },
      ];
      expect(needsReorder(items)).toBe(false);
    });

    it("handles undefined parentUuid as root", () => {
      const items: DagOrderable[] = [
        { id: "a", parentUuid: undefined },
        { id: "b", parentUuid: "a" },
      ];
      expect(needsReorder(items)).toBe(false);
    });
  });

  describe("orderByParentChain", () => {
    it("returns empty array unchanged", () => {
      expect(orderByParentChain([])).toEqual([]);
    });

    it("returns single item unchanged", () => {
      const items = [{ id: "a", parentUuid: null }];
      expect(orderByParentChain(items)).toEqual(items);
    });

    it("returns already-ordered items unchanged (same reference)", () => {
      const items: DagOrderable[] = [
        { id: "a", parentUuid: null },
        { id: "b", parentUuid: "a" },
        { id: "c", parentUuid: "b" },
      ];
      // Should return same array reference when no reorder needed
      expect(orderByParentChain(items)).toBe(items);
    });

    it("reorders when parent comes after child", () => {
      const items: DagOrderable[] = [
        { id: "b", parentUuid: "a" },
        { id: "a", parentUuid: null },
      ];
      const result = orderByParentChain(items);
      expect(result.map((i) => i.id)).toEqual(["a", "b"]);
    });

    it("reorders chain from reverse order", () => {
      const items: DagOrderable[] = [
        { id: "c", parentUuid: "b" },
        { id: "b", parentUuid: "a" },
        { id: "a", parentUuid: null },
      ];
      const result = orderByParentChain(items);
      expect(result.map((i) => i.id)).toEqual(["a", "b", "c"]);
    });

    it("handles race condition: agent response before user message", () => {
      // This is the exact race condition we're fixing
      const items: DagOrderable[] = [
        { id: "agent-1", parentUuid: "user-1" }, // agent response arrived first
        { id: "user-1", parentUuid: null }, // user message arrived second
      ];
      const result = orderByParentChain(items);
      expect(result.map((i) => i.id)).toEqual(["user-1", "agent-1"]);
    });

    it("handles longer race condition scenario", () => {
      // Multi-turn conversation with out-of-order arrival
      const items: DagOrderable[] = [
        { id: "agent-2", parentUuid: "user-2" },
        { id: "user-2", parentUuid: "agent-1" },
        { id: "agent-1", parentUuid: "user-1" },
        { id: "user-1", parentUuid: null },
      ];
      const result = orderByParentChain(items);
      expect(result.map((i) => i.id)).toEqual([
        "user-1",
        "agent-1",
        "user-2",
        "agent-2",
      ]);
    });

    it("appends orphaned items (no parent in chain) at end", () => {
      const items: DagOrderable[] = [
        { id: "a", parentUuid: null },
        { id: "orphan", parentUuid: "missing-parent" }, // parent doesn't exist
        { id: "b", parentUuid: "a" },
      ];
      const result = orderByParentChain(items);
      // a, b form the chain; orphan is appended at end
      expect(result.map((i) => i.id)).toEqual(["a", "b", "orphan"]);
    });

    it("handles items without parentUuid field as roots", () => {
      const items: DagOrderable[] = [
        { id: "b", parentUuid: "a" },
        { id: "a" }, // no parentUuid field = root
      ];
      const result = orderByParentChain(items);
      expect(result.map((i) => i.id)).toEqual(["a", "b"]);
    });

    it("handles multiple roots (branches)", () => {
      const items: DagOrderable[] = [
        { id: "b1", parentUuid: "a1" },
        { id: "a1", parentUuid: null },
        { id: "b2", parentUuid: "a2" },
        { id: "a2", parentUuid: null },
      ];
      const result = orderByParentChain(items);
      // Both branches should be traversed, order depends on input order
      expect(result.length).toBe(4);
      // a1 should come before b1, a2 should come before b2
      const ids = result.map((i) => i.id);
      expect(ids.indexOf("a1")).toBeLessThan(ids.indexOf("b1"));
      expect(ids.indexOf("a2")).toBeLessThan(ids.indexOf("b2"));
    });

    it("preserves extra properties on items", () => {
      interface ExtendedItem extends DagOrderable {
        type: string;
        content: string;
      }
      const items: ExtendedItem[] = [
        { id: "b", parentUuid: "a", type: "assistant", content: "Hello" },
        { id: "a", parentUuid: null, type: "user", content: "Hi" },
      ];
      const result = orderByParentChain(items);
      expect(result[0]).toEqual({
        id: "a",
        parentUuid: null,
        type: "user",
        content: "Hi",
      });
      expect(result[1]).toEqual({
        id: "b",
        parentUuid: "a",
        type: "assistant",
        content: "Hello",
      });
    });
  });
});
