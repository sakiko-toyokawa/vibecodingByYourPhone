import { describe, expect, it } from "vitest";
import {
  type RelayClientConnect,
  type RelayClientConnected,
  type RelayClientError,
  type RelayServerRegister,
  type RelayServerRegistered,
  type RelayServerRejected,
  USERNAME_REGEX,
  isRelayClientConnect,
  isRelayClientConnected,
  isRelayClientError,
  isRelayServerRegister,
  isRelayServerRegistered,
  isRelayServerRejected,
  isValidRelayUsername,
} from "../src/relay-protocol.js";

describe("relay-protocol", () => {
  describe("type guards", () => {
    describe("isRelayServerRegister", () => {
      it("returns true for valid server register message", () => {
        const msg: RelayServerRegister = {
          type: "server_register",
          username: "alice",
          installId: "abc-123",
        };
        expect(isRelayServerRegister(msg)).toBe(true);
      });

      it("returns true when optional compatibility metadata is present", () => {
        const msg: RelayServerRegister = {
          type: "server_register",
          username: "alice",
          installId: "abc-123",
          appVersion: "0.2.0",
          resumeProtocolVersion: 2,
          renderProtocolVersion: 1,
          capabilities: ["git-status", "deviceBridge"],
        };
        expect(isRelayServerRegister(msg)).toBe(true);
      });

      it("returns false for missing username", () => {
        const msg = {
          type: "server_register",
          installId: "abc-123",
        };
        expect(isRelayServerRegister(msg)).toBe(false);
      });

      it("returns false for missing installId", () => {
        const msg = {
          type: "server_register",
          username: "alice",
        };
        expect(isRelayServerRegister(msg)).toBe(false);
      });

      it("returns false for wrong type", () => {
        const msg = {
          type: "server_registered",
          username: "alice",
          installId: "abc-123",
        };
        expect(isRelayServerRegister(msg)).toBe(false);
      });

      it("returns false for invalid resumeProtocolVersion", () => {
        const msg = {
          type: "server_register",
          username: "alice",
          installId: "abc-123",
          resumeProtocolVersion: "2",
        };
        expect(isRelayServerRegister(msg)).toBe(false);
      });

      it("returns false for invalid capabilities", () => {
        const msg = {
          type: "server_register",
          username: "alice",
          installId: "abc-123",
          capabilities: ["git-status", 123],
        };
        expect(isRelayServerRegister(msg)).toBe(false);
      });

      it("returns false for null", () => {
        expect(isRelayServerRegister(null)).toBe(false);
      });

      it("returns false for non-object", () => {
        expect(isRelayServerRegister("server_register")).toBe(false);
      });
    });

    describe("isRelayServerRegistered", () => {
      it("returns true for valid server registered message", () => {
        const msg: RelayServerRegistered = { type: "server_registered" };
        expect(isRelayServerRegistered(msg)).toBe(true);
      });

      it("returns false for wrong type", () => {
        const msg = { type: "server_register" };
        expect(isRelayServerRegistered(msg)).toBe(false);
      });

      it("returns false for null", () => {
        expect(isRelayServerRegistered(null)).toBe(false);
      });
    });

    describe("isRelayServerRejected", () => {
      it("returns true for username_taken rejection", () => {
        const msg: RelayServerRejected = {
          type: "server_rejected",
          reason: "username_taken",
        };
        expect(isRelayServerRejected(msg)).toBe(true);
      });

      it("returns true for invalid_username rejection", () => {
        const msg: RelayServerRejected = {
          type: "server_rejected",
          reason: "invalid_username",
        };
        expect(isRelayServerRejected(msg)).toBe(true);
      });

      it("returns false for invalid reason", () => {
        const msg = {
          type: "server_rejected",
          reason: "other_reason",
        };
        expect(isRelayServerRejected(msg)).toBe(false);
      });

      it("returns false for missing reason", () => {
        const msg = { type: "server_rejected" };
        expect(isRelayServerRejected(msg)).toBe(false);
      });

      it("returns false for wrong type", () => {
        const msg = {
          type: "server_registered",
          reason: "username_taken",
        };
        expect(isRelayServerRejected(msg)).toBe(false);
      });
    });

    describe("isRelayClientConnect", () => {
      it("returns true for valid client connect message", () => {
        const msg: RelayClientConnect = {
          type: "client_connect",
          username: "alice",
        };
        expect(isRelayClientConnect(msg)).toBe(true);
      });

      it("returns false for missing username", () => {
        const msg = { type: "client_connect" };
        expect(isRelayClientConnect(msg)).toBe(false);
      });

      it("returns false for wrong type", () => {
        const msg = {
          type: "client_connected",
          username: "alice",
        };
        expect(isRelayClientConnect(msg)).toBe(false);
      });

      it("returns false for null", () => {
        expect(isRelayClientConnect(null)).toBe(false);
      });
    });

    describe("isRelayClientConnected", () => {
      it("returns true for valid client connected message", () => {
        const msg: RelayClientConnected = { type: "client_connected" };
        expect(isRelayClientConnected(msg)).toBe(true);
      });

      it("returns false for wrong type", () => {
        const msg = { type: "client_connect" };
        expect(isRelayClientConnected(msg)).toBe(false);
      });
    });

    describe("isRelayClientError", () => {
      it("returns true for server_offline error", () => {
        const msg: RelayClientError = {
          type: "client_error",
          reason: "server_offline",
        };
        expect(isRelayClientError(msg)).toBe(true);
      });

      it("returns true for unknown_username error", () => {
        const msg: RelayClientError = {
          type: "client_error",
          reason: "unknown_username",
        };
        expect(isRelayClientError(msg)).toBe(true);
      });

      it("returns false for invalid reason", () => {
        const msg = {
          type: "client_error",
          reason: "timeout",
        };
        expect(isRelayClientError(msg)).toBe(false);
      });

      it("returns false for missing reason", () => {
        const msg = { type: "client_error" };
        expect(isRelayClientError(msg)).toBe(false);
      });

      it("returns false for wrong type", () => {
        const msg = {
          type: "client_connected",
          reason: "server_offline",
        };
        expect(isRelayClientError(msg)).toBe(false);
      });
    });
  });

  describe("username validation", () => {
    describe("USERNAME_REGEX", () => {
      it("matches valid usernames", () => {
        expect(USERNAME_REGEX.test("abc")).toBe(true);
        expect(USERNAME_REGEX.test("alice")).toBe(true);
        expect(USERNAME_REGEX.test("dev-server")).toBe(true);
        expect(USERNAME_REGEX.test("my-home-pc")).toBe(true);
        expect(USERNAME_REGEX.test("a1b")).toBe(true);
        expect(USERNAME_REGEX.test("123")).toBe(true);
        expect(USERNAME_REGEX.test("a-b")).toBe(true);
      });

      it("matches 32-character username (max length)", () => {
        const maxLength = `a${"b".repeat(30)}c`;
        expect(maxLength.length).toBe(32);
        expect(USERNAME_REGEX.test(maxLength)).toBe(true);
      });

      it("rejects 2-character username (too short)", () => {
        expect(USERNAME_REGEX.test("ab")).toBe(false);
      });

      it("rejects 33-character username (too long)", () => {
        const tooLong = `a${"b".repeat(31)}c`;
        expect(tooLong.length).toBe(33);
        expect(USERNAME_REGEX.test(tooLong)).toBe(false);
      });

      it("rejects username starting with hyphen", () => {
        expect(USERNAME_REGEX.test("-abc")).toBe(false);
      });

      it("rejects username ending with hyphen", () => {
        expect(USERNAME_REGEX.test("abc-")).toBe(false);
      });

      it("rejects username with uppercase letters", () => {
        expect(USERNAME_REGEX.test("Alice")).toBe(false);
        expect(USERNAME_REGEX.test("ALICE")).toBe(false);
        expect(USERNAME_REGEX.test("alicE")).toBe(false);
      });

      it("rejects username with spaces", () => {
        expect(USERNAME_REGEX.test("alice bob")).toBe(false);
      });

      it("rejects username with underscores", () => {
        expect(USERNAME_REGEX.test("alice_bob")).toBe(false);
      });

      it("rejects username with special characters", () => {
        expect(USERNAME_REGEX.test("alice@bob")).toBe(false);
        expect(USERNAME_REGEX.test("alice.bob")).toBe(false);
        expect(USERNAME_REGEX.test("alice!")).toBe(false);
      });

      it("rejects empty string", () => {
        expect(USERNAME_REGEX.test("")).toBe(false);
      });

      it("rejects single character", () => {
        expect(USERNAME_REGEX.test("a")).toBe(false);
      });
    });

    describe("isValidRelayUsername", () => {
      it("returns true for valid usernames", () => {
        expect(isValidRelayUsername("alice")).toBe(true);
        expect(isValidRelayUsername("dev-server")).toBe(true);
        expect(isValidRelayUsername("my-home-pc")).toBe(true);
        expect(isValidRelayUsername("abc")).toBe(true);
      });

      it("returns false for invalid usernames", () => {
        expect(isValidRelayUsername("")).toBe(false);
        expect(isValidRelayUsername("ab")).toBe(false);
        expect(isValidRelayUsername("-abc")).toBe(false);
        expect(isValidRelayUsername("abc-")).toBe(false);
        expect(isValidRelayUsername("Alice")).toBe(false);
        expect(isValidRelayUsername("alice bob")).toBe(false);
      });
    });
  });
});
