import { describe, expect, it } from "vitest";
import { setsEqual } from "../useDrafts";

describe("setsEqual", () => {
  it("returns prev when both sets are empty", () => {
    const prev = new Set<string>();
    const next = new Set<string>();
    expect(setsEqual(prev, next)).toBe(prev);
  });

  it("returns prev when contents are identical", () => {
    const prev = new Set(["a", "b", "c"]);
    const next = new Set(["a", "b", "c"]);
    expect(setsEqual(prev, next)).toBe(prev);
  });

  it("returns next when an element is added", () => {
    const prev = new Set(["a", "b"]);
    const next = new Set(["a", "b", "c"]);
    expect(setsEqual(prev, next)).toBe(next);
  });

  it("returns next when an element is removed", () => {
    const prev = new Set(["a", "b", "c"]);
    const next = new Set(["a", "b"]);
    expect(setsEqual(prev, next)).toBe(next);
  });

  it("returns next when an element is swapped (same size, different content)", () => {
    const prev = new Set(["a", "b"]);
    const next = new Set(["a", "c"]);
    expect(setsEqual(prev, next)).toBe(next);
  });

  it("returns next when going from empty to non-empty", () => {
    const prev = new Set<string>();
    const next = new Set(["a"]);
    expect(setsEqual(prev, next)).toBe(next);
  });

  it("returns next when going from non-empty to empty", () => {
    const prev = new Set(["a"]);
    const next = new Set<string>();
    expect(setsEqual(prev, next)).toBe(next);
  });

  it("returns prev for single identical element", () => {
    const prev = new Set(["x"]);
    const next = new Set(["x"]);
    expect(setsEqual(prev, next)).toBe(prev);
  });

  it("returns next when completely disjoint sets of same size", () => {
    const prev = new Set(["a", "b", "c"]);
    const next = new Set(["x", "y", "z"]);
    expect(setsEqual(prev, next)).toBe(next);
  });
});
