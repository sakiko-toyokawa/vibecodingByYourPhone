/**
 * Connection metadata types shared between relay and SRP protocols.
 * Extracted to avoid circular dependencies.
 */

/** Origin metadata sent with connection for tracking */
export interface OriginMetadata {
  /** Full origin string (e.g., "https://localhost:3400") */
  origin: string;
  /** URL scheme (e.g., "https", "http") */
  scheme: string;
  /** Hostname without port */
  hostname: string;
  /** Port number, or null if default port */
  port: number | null;
  /** User agent string */
  userAgent: string;
}
