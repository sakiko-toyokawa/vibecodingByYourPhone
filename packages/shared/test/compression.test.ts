import { describe, expect, it } from "vitest";
import {
  BinaryFormat,
  decodeCompressedJsonFrame,
  encodeCompressedJsonFrame,
} from "../src/binary-framing.js";
import {
  COMPRESSION_THRESHOLD,
  compressBytes,
  compressJsonIfBeneficial,
  compressString,
  decompressBytes,
  decompressToString,
  isCompressionSupported,
  isGzipCompressed,
  shouldCompress,
} from "../src/compression.js";

// Skip tests if compression APIs are not available (e.g., older Node.js versions)
const compressionAvailable = isCompressionSupported();

describe("compression", () => {
  describe("COMPRESSION_THRESHOLD", () => {
    it("is 1KB", () => {
      expect(COMPRESSION_THRESHOLD).toBe(1024);
    });
  });

  describe("isCompressionSupported", () => {
    it("returns boolean", () => {
      expect(typeof isCompressionSupported()).toBe("boolean");
    });
  });

  describe("shouldCompress", () => {
    it("returns false for small strings", () => {
      expect(shouldCompress("hello")).toBe(false);
      expect(shouldCompress("")).toBe(false);
      expect(shouldCompress("a".repeat(1024))).toBe(false); // Exactly 1KB
    });

    it("returns true for strings > 1KB", () => {
      expect(shouldCompress("a".repeat(1025))).toBe(true);
      expect(shouldCompress("a".repeat(10000))).toBe(true);
    });

    it("handles UTF-8 multi-byte characters correctly", () => {
      // Each emoji is 4 bytes in UTF-8
      const emoji = "🎉";
      // 256 emojis = 1024 bytes
      expect(shouldCompress(emoji.repeat(256))).toBe(false);
      // 257 emojis = 1028 bytes
      expect(shouldCompress(emoji.repeat(257))).toBe(true);
    });

    it("works with Uint8Array", () => {
      expect(shouldCompress(new Uint8Array(1024))).toBe(false);
      expect(shouldCompress(new Uint8Array(1025))).toBe(true);
    });
  });

  describe("isGzipCompressed", () => {
    it("returns true for gzip magic bytes", () => {
      expect(isGzipCompressed(new Uint8Array([0x1f, 0x8b, 0x08]))).toBe(true);
    });

    it("returns false for non-gzip data", () => {
      expect(isGzipCompressed(new Uint8Array([0x00, 0x00]))).toBe(false);
      expect(isGzipCompressed(new Uint8Array([0x1f, 0x00]))).toBe(false);
      expect(isGzipCompressed(new Uint8Array([0x00, 0x8b]))).toBe(false);
    });

    it("returns false for short data", () => {
      expect(isGzipCompressed(new Uint8Array([0x1f]))).toBe(false);
      expect(isGzipCompressed(new Uint8Array([]))).toBe(false);
    });
  });

  describe.skipIf(!compressionAvailable)("compressString", () => {
    it("compresses a string", async () => {
      const input = "hello world";
      const compressed = await compressString(input);
      if (compressed === null) {
        throw new Error("Expected compression to succeed");
      }
      expect(compressed).toBeInstanceOf(Uint8Array);
      expect(isGzipCompressed(compressed)).toBe(true);
    });

    it("compresses large strings", async () => {
      const input = "a".repeat(10000);
      const compressed = await compressString(input);
      if (compressed === null) {
        throw new Error("Expected compression to succeed");
      }
      // Compression should significantly reduce size for repetitive data
      expect(compressed.length).toBeLessThan(input.length);
    });

    it("compresses UTF-8 content", async () => {
      const input = "日本語テスト 🎉 Hello World!";
      const compressed = await compressString(input);
      if (compressed === null) {
        throw new Error("Expected compression to succeed");
      }
      expect(isGzipCompressed(compressed)).toBe(true);
    });
  });

  describe.skipIf(!compressionAvailable)("compressBytes", () => {
    it("compresses bytes", async () => {
      const input = new Uint8Array([1, 2, 3, 4, 5]);
      const compressed = await compressBytes(input);
      if (compressed === null) {
        throw new Error("Expected compression to succeed");
      }
      expect(isGzipCompressed(compressed)).toBe(true);
    });
  });

  describe.skipIf(!compressionAvailable)("decompressToString", () => {
    it("round-trips with compressString", async () => {
      const input = "hello world";
      const compressed = await compressString(input);
      if (compressed === null) {
        throw new Error("Expected compression to succeed");
      }
      const decompressed = await decompressToString(compressed);
      expect(decompressed).toBe(input);
    });

    it("round-trips UTF-8 content", async () => {
      const input = "日本語テスト 🎉 Hello World!";
      const compressed = await compressString(input);
      if (compressed === null) {
        throw new Error("Expected compression to succeed");
      }
      const decompressed = await decompressToString(compressed);
      expect(decompressed).toBe(input);
    });

    it("round-trips large strings", async () => {
      const input = "a".repeat(100000) + "b".repeat(100000);
      const compressed = await compressString(input);
      if (compressed === null) {
        throw new Error("Expected compression to succeed");
      }
      const decompressed = await decompressToString(compressed);
      expect(decompressed).toBe(input);
    });

    it("round-trips JSON payloads", async () => {
      const input = JSON.stringify({
        type: "response",
        id: "test-123",
        status: 200,
        body: {
          messages: Array(100)
            .fill(null)
            .map((_, i) => ({
              id: `msg-${i}`,
              text: `This is message number ${i} with some repeated content to make it larger.`,
            })),
        },
      });
      const compressed = await compressString(input);
      if (compressed === null) {
        throw new Error("Expected compression to succeed");
      }
      const decompressed = await decompressToString(compressed);
      expect(decompressed).toBe(input);
      if (decompressed === null) {
        throw new Error("Expected decompression to succeed");
      }
      expect(JSON.parse(decompressed)).toEqual(JSON.parse(input));
    });
  });

  describe.skipIf(!compressionAvailable)("decompressBytes", () => {
    it("round-trips with compressBytes", async () => {
      const input = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const compressed = await compressBytes(input);
      if (compressed === null) {
        throw new Error("Expected compression to succeed");
      }
      const decompressed = await decompressBytes(compressed);
      expect(decompressed).toEqual(input);
    });
  });

  describe.skipIf(!compressionAvailable)("compressJsonIfBeneficial", () => {
    it("does not compress small payloads", async () => {
      const json = JSON.stringify({ small: true });
      const result = await compressJsonIfBeneficial(json);
      expect(result.compressed).toBe(false);
      expect(new TextDecoder().decode(result.bytes)).toBe(json);
    });

    it("compresses large payloads", async () => {
      const json = JSON.stringify({ data: "a".repeat(2000) });
      const result = await compressJsonIfBeneficial(json);
      expect(result.compressed).toBe(true);
      expect(isGzipCompressed(result.bytes)).toBe(true);
      // Verify round-trip
      const decompressed = await decompressToString(result.bytes);
      expect(decompressed).toBe(json);
    });

    it("does not compress if result is larger", async () => {
      // Random data doesn't compress well
      const randomBytes = Array(2000)
        .fill(null)
        .map(() => Math.floor(Math.random() * 256));
      const json = JSON.stringify({ data: randomBytes });
      const result = await compressJsonIfBeneficial(json);
      // Result might or might not be compressed depending on the data
      // but if it's not compressed, we should get the original back
      if (!result.compressed) {
        expect(new TextDecoder().decode(result.bytes)).toBe(json);
      }
    });
  });
});

describe("compressed JSON frames (Phase 3)", () => {
  describe("encodeCompressedJsonFrame", () => {
    it("prepends format byte 0x03", () => {
      const compressed = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]); // gzip magic
      const frame = encodeCompressedJsonFrame(compressed);
      const view = new Uint8Array(frame);
      expect(view[0]).toBe(BinaryFormat.COMPRESSED_JSON);
      expect(view.slice(1)).toEqual(compressed);
    });

    it("calculates correct size", () => {
      const compressed = new Uint8Array(100);
      const frame = encodeCompressedJsonFrame(compressed);
      expect(frame.byteLength).toBe(101); // 1 + 100
    });
  });

  describe("decodeCompressedJsonFrame", () => {
    it("extracts compressed payload", () => {
      const compressed = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
      const frame = encodeCompressedJsonFrame(compressed);
      const payload = decodeCompressedJsonFrame(frame);
      expect(payload).toEqual(compressed);
    });

    it("throws for wrong format byte", () => {
      const frame = new Uint8Array([BinaryFormat.JSON, 0x01, 0x02]);
      expect(() => decodeCompressedJsonFrame(frame)).toThrow();
    });

    it("round-trips", () => {
      const original = new Uint8Array([
        0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03,
      ]);
      const frame = encodeCompressedJsonFrame(original);
      const decoded = decodeCompressedJsonFrame(frame);
      expect(decoded).toEqual(original);
    });
  });

  describe.skipIf(!compressionAvailable)(
    "integration: compress and frame",
    () => {
      it("compresses JSON and creates frame", async () => {
        const json = JSON.stringify({ data: "a".repeat(2000) });
        const compressed = await compressString(json);
        if (compressed === null) {
          throw new Error("Expected compression to succeed");
        }
        const frame = encodeCompressedJsonFrame(compressed);

        // Decode frame
        const payload = decodeCompressedJsonFrame(frame);
        expect(isGzipCompressed(payload)).toBe(true);

        // Decompress and verify
        const decompressed = await decompressToString(payload);
        expect(decompressed).toBe(json);
      });
    },
  );
});
