/**
 * Compression utilities for WebSocket relay protocol (Phase 3).
 *
 * Uses native CompressionStream/DecompressionStream APIs (Chrome 80+, Firefox 113+, Safari 16.4+).
 * Falls back gracefully when compression APIs are unavailable.
 *
 * Threshold-based compression: only compress payloads > 1KB to avoid overhead on small messages.
 */

/** Minimum payload size in bytes before compression is attempted */
export const COMPRESSION_THRESHOLD = 1024;

/** Gzip magic bytes (first 2 bytes of a gzip stream) */
const GZIP_MAGIC = [0x1f, 0x8b];

/**
 * Check if native compression APIs are available.
 * Returns true if both CompressionStream and DecompressionStream are supported.
 */
export function isCompressionSupported(): boolean {
  return (
    typeof CompressionStream !== "undefined" &&
    typeof DecompressionStream !== "undefined"
  );
}

/**
 * Check if a payload should be compressed based on size threshold.
 *
 * @param payload - UTF-8 string or byte array to potentially compress
 * @returns true if payload is larger than COMPRESSION_THRESHOLD
 */
export function shouldCompress(payload: string | Uint8Array): boolean {
  const size =
    typeof payload === "string"
      ? new TextEncoder().encode(payload).length
      : payload.length;
  return size > COMPRESSION_THRESHOLD;
}

/**
 * Check if data appears to be gzip-compressed by checking magic bytes.
 *
 * @param data - Bytes to check
 * @returns true if data starts with gzip magic bytes
 */
export function isGzipCompressed(data: Uint8Array): boolean {
  return (
    data.length >= 2 && data[0] === GZIP_MAGIC[0] && data[1] === GZIP_MAGIC[1]
  );
}

/**
 * Compress a UTF-8 string using gzip.
 *
 * @param input - UTF-8 string to compress
 * @returns Compressed bytes, or null if compression is not supported
 * @throws Error if compression fails
 */
export async function compressString(
  input: string,
): Promise<Uint8Array | null> {
  if (!isCompressionSupported()) {
    return null;
  }

  const inputBytes = new TextEncoder().encode(input);
  return compressBytes(inputBytes);
}

/**
 * Compress bytes using gzip.
 *
 * @param input - Bytes to compress
 * @returns Compressed bytes, or null if compression is not supported
 * @throws Error if compression fails
 */
export async function compressBytes(
  input: Uint8Array,
): Promise<Uint8Array | null> {
  if (!isCompressionSupported()) {
    return null;
  }

  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  // Create a fresh ArrayBuffer copy to satisfy TypeScript's strict ArrayBuffer type
  const inputBuffer = new ArrayBuffer(input.length);
  new Uint8Array(inputBuffer).set(input);
  writer.write(new Uint8Array(inputBuffer));
  writer.close();

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  // Concatenate all chunks
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Decompress gzip-compressed bytes to a UTF-8 string.
 *
 * @param input - Gzip-compressed bytes
 * @returns Decompressed UTF-8 string, or null if decompression is not supported
 * @throws Error if decompression fails
 */
export async function decompressToString(
  input: Uint8Array,
): Promise<string | null> {
  const bytes = await decompressBytes(input);
  if (bytes === null) {
    return null;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Decompress gzip-compressed bytes.
 *
 * @param input - Gzip-compressed bytes
 * @returns Decompressed bytes, or null if decompression is not supported
 * @throws Error if decompression fails
 */
export async function decompressBytes(
  input: Uint8Array,
): Promise<Uint8Array | null> {
  if (!isCompressionSupported()) {
    return null;
  }

  const stream = new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  // Create a fresh ArrayBuffer copy to satisfy TypeScript's strict ArrayBuffer type
  const inputBuffer = new ArrayBuffer(input.length);
  new Uint8Array(inputBuffer).set(input);
  writer.write(new Uint8Array(inputBuffer));
  writer.close();

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  // Concatenate all chunks
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Compress JSON if it exceeds the threshold and compression is supported.
 * Returns the original string encoded as bytes if compression is not beneficial.
 *
 * @param json - JSON string to potentially compress
 * @returns Object with compressed bytes and whether compression was applied
 */
export async function compressJsonIfBeneficial(json: string): Promise<{
  bytes: Uint8Array;
  compressed: boolean;
}> {
  const jsonBytes = new TextEncoder().encode(json);

  // Don't compress small payloads
  if (!shouldCompress(json)) {
    return { bytes: jsonBytes, compressed: false };
  }

  // Try compression if supported
  const compressed = await compressString(json);
  if (compressed === null) {
    // Compression not supported
    return { bytes: jsonBytes, compressed: false };
  }

  // Only use compression if it actually reduces size
  if (compressed.length >= jsonBytes.length) {
    return { bytes: jsonBytes, compressed: false };
  }

  return { bytes: compressed, compressed: true };
}
