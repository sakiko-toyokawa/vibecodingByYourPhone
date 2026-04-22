/**
 * Branded types for project identification.
 *
 * Two formats exist:
 * - UrlProjectId: base64url of absolute path (reversible)
 * - DirProjectId: slash-to-hyphen encoding (lossy, NOT reversible)
 *
 * Using branded types makes format mismatches a compile-time error.
 */

/** Base64url encoded absolute path - used in URLs, API, client state */
export type UrlProjectId = string & { readonly __brand: "UrlProjectId" };

/** Directory-format path suffix - used in ~/.claude/projects/ file paths */
export type DirProjectId = string & { readonly __brand: "DirProjectId" };

/**
 * Type guard: Check if string is valid UrlProjectId format.
 * Base64url alphabet: [A-Za-z0-9_-], no padding required.
 */
export function isUrlProjectId(value: string): value is UrlProjectId {
  return /^[A-Za-z0-9_-]+$/.test(value) && value.length > 0;
}

/**
 * Type guard: Check if string is valid DirProjectId format.
 * Directory format: starts with hyphen OR hostname followed by slash-hyphen.
 */
export function isDirProjectId(value: string): value is DirProjectId {
  return value.startsWith("-") || /^[a-zA-Z0-9.-]+\/-/.test(value);
}

/**
 * Create UrlProjectId from absolute path.
 * Uses browser-compatible base64url encoding.
 */
export function toUrlProjectId(absolutePath: string): UrlProjectId {
  // TextEncoder works in both browser and Node
  const bytes = new TextEncoder().encode(absolutePath);
  // Convert to base64, then to base64url (replace +/= with -_)
  const base64 = btoa(String.fromCharCode(...bytes));
  const base64url = base64
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return base64url as UrlProjectId;
}

/**
 * Decode UrlProjectId back to absolute path.
 * Uses browser-compatible base64url decoding.
 */
export function fromUrlProjectId(id: UrlProjectId): string {
  // Convert base64url back to base64
  let base64 = id.replace(/-/g, "+").replace(/_/g, "/");
  // Add padding if needed
  while (base64.length % 4) {
    base64 += "=";
  }
  // Decode
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Assertion function for API boundaries.
 * Throws if value is not a valid UrlProjectId format.
 */
export function assertUrlProjectId(
  value: string,
): asserts value is UrlProjectId {
  if (!isUrlProjectId(value)) {
    throw new Error(
      `Invalid UrlProjectId format: ${value.slice(0, 30)}${value.length > 30 ? "..." : ""}`,
    );
  }
}

/**
 * Cast a string to DirProjectId (for use when parsing from known directory paths).
 * Use with caution - only when you know the value comes from a directory path.
 */
export function asDirProjectId(value: string): DirProjectId {
  return value as DirProjectId;
}
