import { describe, expect, it } from "vitest";
import {
  isValidSshHostAlias,
  normalizeSshHostAlias,
} from "../../src/utils/sshHostAlias.js";

describe("sshHostAlias utils", () => {
  describe("normalizeSshHostAlias", () => {
    it("trims surrounding whitespace", () => {
      expect(normalizeSshHostAlias("  devbox  ")).toBe("devbox");
    });
  });

  describe("isValidSshHostAlias", () => {
    it("accepts conservative alias-like values", () => {
      expect(isValidSshHostAlias("devbox")).toBe(true);
      expect(isValidSshHostAlias("gpu-server")).toBe(true);
      expect(isValidSshHostAlias("prod.db1")).toBe(true);
      expect(isValidSshHostAlias("A1_b2-C3")).toBe(true);
    });

    it("rejects option-like or unsafe values", () => {
      expect(isValidSshHostAlias("-oProxyCommand=whoami")).toBe(false);
      expect(isValidSshHostAlias("bad host")).toBe(false);
      expect(isValidSshHostAlias("user@host")).toBe(false);
      expect(isValidSshHostAlias("host:22")).toBe(false);
      expect(isValidSshHostAlias("")).toBe(false);
    });

    it("enforces max length", () => {
      expect(isValidSshHostAlias("a".repeat(128))).toBe(true);
      expect(isValidSshHostAlias("a".repeat(129))).toBe(false);
    });
  });
});
