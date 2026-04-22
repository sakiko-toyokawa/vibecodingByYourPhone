import { gunzipSync, gzipSync } from "node:zlib";
/**
 * NaCl secretbox encryption helpers for relay protocol.
 *
 * Uses TweetNaCl for XSalsa20-Poly1305 authenticated encryption.
 * Supports both JSON envelope format (Phase 2) and binary envelope format (Phase 1).
 * Phase 3 adds gzip compression support using Node.js zlib.
 */
import {
  BinaryEnvelopeError,
  BinaryFormat,
  type BinaryFormatValue,
  COMPRESSION_THRESHOLD,
  createBinaryEnvelope,
  extractFormatAndPayload,
  parseBinaryEnvelope,
  prependFormatByte,
} from "@yep-anywhere/shared";
import nacl from "tweetnacl";

/** Nonce length for secretbox (24 bytes) */
export const NONCE_LENGTH = nacl.secretbox.nonceLength;

/** Key length for secretbox (32 bytes) */
export const KEY_LENGTH = nacl.secretbox.keyLength;

/** Generate a random 24-byte nonce */
export function generateNonce(): Uint8Array {
  return nacl.randomBytes(NONCE_LENGTH);
}

/**
 * Encrypt a plaintext message with NaCl secretbox.
 * @param plaintext - The message to encrypt (UTF-8 string)
 * @param key - The 32-byte secret key
 * @returns Object with base64-encoded nonce and ciphertext
 */
export function encrypt(
  plaintext: string,
  key: Uint8Array,
): { nonce: string; ciphertext: string } {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Key must be ${KEY_LENGTH} bytes, got ${key.length}`);
  }
  const nonce = generateNonce();
  const message = new TextEncoder().encode(plaintext);
  const ciphertext = nacl.secretbox(message, nonce, key);
  return {
    nonce: Buffer.from(nonce).toString("base64"),
    ciphertext: Buffer.from(ciphertext).toString("base64"),
  };
}

/**
 * Decrypt a message encrypted with NaCl secretbox.
 * @param nonce - Base64-encoded nonce
 * @param ciphertext - Base64-encoded ciphertext
 * @param key - The 32-byte secret key
 * @returns Decrypted plaintext string, or null if decryption failed
 */
export function decrypt(
  nonce: string,
  ciphertext: string,
  key: Uint8Array,
): string | null {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Key must be ${KEY_LENGTH} bytes, got ${key.length}`);
  }
  const nonceBytes = Buffer.from(nonce, "base64");
  const ciphertextBytes = Buffer.from(ciphertext, "base64");

  if (nonceBytes.length !== NONCE_LENGTH) {
    return null;
  }

  const plaintext = nacl.secretbox.open(ciphertextBytes, nonceBytes, key);
  if (!plaintext) {
    return null;
  }
  return new TextDecoder().decode(plaintext);
}

/**
 * Derive a 32-byte secretbox key from an SRP session key.
 *
 * SRP produces a large session key (typically 256+ bytes). We hash it
 * with SHA-512 and take the first 32 bytes for use with secretbox.
 *
 * @param srpSessionKey - The raw session key from SRP
 * @returns 32-byte key suitable for secretbox
 */
export function deriveSecretboxKey(srpSessionKey: Uint8Array): Uint8Array {
  return nacl.hash(srpSessionKey).slice(0, KEY_LENGTH);
}

/**
 * Derive a per-connection traffic key from a long-lived base key plus a
 * server-issued nonce. This prevents ciphertext replay across reconnect/resume
 * boundaries because each connection gets a distinct encryption key.
 */
export function deriveTransportKey(
  baseKey: Uint8Array,
  transportNonceBase64: string,
): Uint8Array {
  if (baseKey.length !== KEY_LENGTH) {
    throw new Error(`Key must be ${KEY_LENGTH} bytes, got ${baseKey.length}`);
  }

  const nonce = Buffer.from(transportNonceBase64, "base64");
  if (nonce.length !== NONCE_LENGTH) {
    throw new Error(
      `Transport nonce must decode to ${NONCE_LENGTH} bytes, got ${nonce.length}`,
    );
  }

  // Domain-separated hash: H("yep-transport-v1" || baseKey || nonce)[0..31]
  const label = Buffer.from("yep-transport-v1", "utf8");
  const material = Buffer.concat([label, Buffer.from(baseKey), nonce]);
  return nacl.hash(material).slice(0, KEY_LENGTH);
}

/**
 * Generate a random 32-byte key for testing.
 */
export function generateRandomKey(): Uint8Array {
  return nacl.randomBytes(KEY_LENGTH);
}

// =============================================================================
// Phase 1: Binary Encrypted Envelope
// =============================================================================

/**
 * Encrypt a message to binary envelope format.
 * Wire format: [1 byte: version][24 bytes: nonce][ciphertext]
 * Where ciphertext decrypts to: [1 byte: format][payload]
 *
 * @param plaintext - UTF-8 string to encrypt (will be JSON format 0x01)
 * @param key - 32-byte secret key
 * @returns ArrayBuffer containing the binary envelope
 */
export function encryptToBinaryEnvelope(
  plaintext: string,
  key: Uint8Array,
): ArrayBuffer {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Key must be ${KEY_LENGTH} bytes, got ${key.length}`);
  }

  const nonce = generateNonce();
  const message = new TextEncoder().encode(plaintext);

  // Prepend format byte (0x01 for JSON)
  const innerPayload = prependFormatByte(BinaryFormat.JSON, message);

  // Encrypt the inner payload
  const ciphertext = nacl.secretbox(innerPayload, nonce, key);

  // Create the binary envelope
  return createBinaryEnvelope(nonce, ciphertext);
}

/**
 * Encrypt raw bytes to binary envelope format with a specified format byte.
 *
 * @param data - Raw bytes to encrypt
 * @param format - Format byte (0x01 = JSON, 0x02 = binary upload, 0x03 = compressed)
 * @param key - 32-byte secret key
 * @returns ArrayBuffer containing the binary envelope
 */
export function encryptBytesToBinaryEnvelope(
  data: Uint8Array,
  format: BinaryFormatValue,
  key: Uint8Array,
): ArrayBuffer {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Key must be ${KEY_LENGTH} bytes, got ${key.length}`);
  }

  const nonce = generateNonce();

  // Prepend format byte
  const innerPayload = prependFormatByte(format, data);

  // Encrypt the inner payload
  const ciphertext = nacl.secretbox(innerPayload, nonce, key);

  // Create the binary envelope
  return createBinaryEnvelope(nonce, ciphertext);
}

/**
 * Decrypt a binary envelope and return the plaintext string.
 * Expects format byte 0x01 (JSON).
 *
 * @param data - Binary envelope (ArrayBuffer or Uint8Array)
 * @param key - 32-byte secret key
 * @returns Decrypted plaintext string, or null if decryption failed
 * @throws BinaryEnvelopeError if envelope format is invalid or format byte is not 0x01
 */
export function decryptBinaryEnvelope(
  data: ArrayBuffer | Uint8Array,
  key: Uint8Array,
): string | null {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Key must be ${KEY_LENGTH} bytes, got ${key.length}`);
  }

  // Parse envelope components
  const { nonce, ciphertext } = parseBinaryEnvelope(data);

  // Decrypt
  const decrypted = nacl.secretbox.open(ciphertext, nonce, key);
  if (!decrypted) {
    return null;
  }

  // Extract format byte and payload
  const { format, payload } = extractFormatAndPayload(decrypted);

  // For now, only support JSON format
  if (format !== BinaryFormat.JSON) {
    throw new BinaryEnvelopeError(
      `Expected JSON format (0x01), got 0x${format.toString(16).padStart(2, "0")}`,
      "INVALID_FORMAT",
    );
  }

  // Decode UTF-8 payload
  return new TextDecoder().decode(payload);
}

/**
 * Decrypt a binary envelope and return raw bytes with format info.
 * Supports all format types (JSON, binary upload, compressed).
 *
 * @param data - Binary envelope (ArrayBuffer or Uint8Array)
 * @param key - 32-byte secret key
 * @returns Object with format byte and payload bytes, or null if decryption failed
 * @throws BinaryEnvelopeError if envelope format is invalid
 */
export function decryptBinaryEnvelopeRaw(
  data: ArrayBuffer | Uint8Array,
  key: Uint8Array,
): { format: BinaryFormatValue; payload: Uint8Array } | null {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Key must be ${KEY_LENGTH} bytes, got ${key.length}`);
  }

  // Parse envelope components
  const { nonce, ciphertext } = parseBinaryEnvelope(data);

  // Decrypt
  const decrypted = nacl.secretbox.open(ciphertext, nonce, key);
  if (!decrypted) {
    return null;
  }

  // Extract format byte and payload
  return extractFormatAndPayload(decrypted);
}

// =============================================================================
// Phase 3: Compression Support
// =============================================================================

/**
 * Compress a string using gzip (synchronous, Node.js).
 *
 * @param input - UTF-8 string to compress
 * @returns Compressed bytes
 */
export function compressGzip(input: string): Uint8Array {
  const inputBytes = Buffer.from(input, "utf-8");
  const compressed = gzipSync(inputBytes);
  return new Uint8Array(compressed);
}

/**
 * Decompress gzip-compressed bytes to a string (synchronous, Node.js).
 *
 * @param input - Gzip-compressed bytes
 * @returns Decompressed UTF-8 string
 * @throws Error if decompression fails
 */
export function decompressGzip(input: Uint8Array): string {
  const decompressed = gunzipSync(Buffer.from(input));
  return decompressed.toString("utf-8");
}

/**
 * Encrypt a message with optional compression to binary envelope format.
 * Automatically compresses if payload exceeds threshold and client supports it.
 *
 * @param plaintext - UTF-8 string to encrypt
 * @param key - 32-byte secret key
 * @param supportsCompression - Whether client supports format 0x03
 * @returns ArrayBuffer containing the binary envelope
 */
export function encryptToBinaryEnvelopeWithCompression(
  plaintext: string,
  key: Uint8Array,
  supportsCompression: boolean,
): ArrayBuffer {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Key must be ${KEY_LENGTH} bytes, got ${key.length}`);
  }

  const nonce = generateNonce();
  const messageBytes = Buffer.from(plaintext, "utf-8");

  // Compression-before-encryption security note (reviewed 2026-02-21):
  // This can theoretically enable CRIME/BREACH-style length-oracle attacks.
  // We currently accept the risk because this relay path requires authenticated
  // E2E traffic, uses per-message gzip streams (no cross-message compression
  // context), and has no known high-risk secret-reflection responses.
  // If the threat model changes, prefer ciphertext length bucketing/padding
  // for sensitive message classes rather than removing compression globally.
  // Check if we should compress
  let innerPayload: Uint8Array;
  if (supportsCompression && messageBytes.length > COMPRESSION_THRESHOLD) {
    const compressed = compressGzip(plaintext);
    // Only use compression if it actually reduces size
    if (compressed.length < messageBytes.length) {
      innerPayload = prependFormatByte(
        BinaryFormat.COMPRESSED_JSON,
        compressed,
      );
    } else {
      innerPayload = prependFormatByte(BinaryFormat.JSON, messageBytes);
    }
  } else {
    innerPayload = prependFormatByte(BinaryFormat.JSON, messageBytes);
  }

  // Encrypt the inner payload
  const ciphertext = nacl.secretbox(innerPayload, nonce, key);

  // Create the binary envelope
  return createBinaryEnvelope(nonce, ciphertext);
}
