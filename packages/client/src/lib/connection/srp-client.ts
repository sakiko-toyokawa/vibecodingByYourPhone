/**
 * SRP-6a client helpers for remote access authentication.
 *
 * Uses tssrp6a library with 2048-bit prime group and SHA-256.
 * The library is loaded lazily via dynamic import() to avoid crashing
 * in non-secure contexts (HTTP on LAN IPs) where crypto.subtle is
 * unavailable — tssrp6a checks crypto.subtle at module init time.
 */
import type {
  SRPClientSessionStep1,
  SRPClientSessionStep2,
  SRPClientSession as SRPClientSessionType,
} from "tssrp6a";

let _tssrp6a: typeof import("tssrp6a") | null = null;

async function loadSrp() {
  if (!_tssrp6a) {
    _tssrp6a = await import("tssrp6a");
  }
  return _tssrp6a;
}

/**
 * Convert bigint to hex string.
 */
function bigIntToHex(n: bigint): string {
  return n.toString(16);
}

/**
 * Convert hex string to bigint.
 */
function hexToBigInt(hex: string): bigint {
  return BigInt(`0x${hex}`);
}

/**
 * Client SRP session wrapper for WebSocket authentication.
 *
 * Usage:
 * 1. Create session: `new SrpClientSession()`
 * 2. Generate hello: `session.generateHello(identity, password)` → returns { identity, A }
 * 3. Process challenge: `session.processChallenge(salt, B)` → returns { M1 }
 * 4. Verify server: `session.verifyServer(M2)` → returns true/false
 * 5. Get key: `session.getSessionKey()` → returns raw session key bytes
 */
export class SrpClientSession {
  private session: SRPClientSessionType | null = null;
  private step1Result: SRPClientSessionStep1 | null = null;
  private step2Result: SRPClientSessionStep2 | null = null;
  private sessionKey: Uint8Array | null = null;
  private identity: string | null = null;

  /**
   * Generate hello message (step 1).
   * This must be called first with the username and password.
   *
   * @param identity - Username
   * @param password - Password (used to derive verifier, not transmitted)
   * @returns Hello message with identity (can be sent immediately, A comes from step 2)
   */
  async generateHello(
    identity: string,
    password: string,
  ): Promise<{ identity: string }> {
    const { SRPClientSession, SRPParameters, SRPRoutines } = await loadSrp();
    const params = new SRPParameters();
    const routines = new SRPRoutines(params);
    this.session = new SRPClientSession(routines);

    this.identity = identity;
    this.step1Result = await this.session.step1(identity, password);
    return { identity };
  }

  /**
   * Process server challenge and generate proof (step 2).
   *
   * @param salt - Salt from server (hex string)
   * @param serverB - Server public value B (hex string)
   * @returns Client public value A and proof M1 (hex strings)
   */
  async processChallenge(
    salt: string,
    serverB: string,
  ): Promise<{ A: string; M1: string }> {
    if (!this.step1Result) {
      throw new Error("Must call generateHello before processChallenge");
    }

    const saltBigInt = hexToBigInt(salt);
    const B = hexToBigInt(serverB);

    // Step 2: Generate client's public value and proof
    this.step2Result = await this.step1Result.step2(saltBigInt, B);

    return {
      A: bigIntToHex(this.step2Result.A),
      M1: bigIntToHex(this.step2Result.M1),
    };
  }

  /**
   * Verify server proof (step 3).
   *
   * @param serverM2 - Server proof M2 (hex string)
   * @returns true if server is verified, false otherwise
   */
  async verifyServer(serverM2: string): Promise<boolean> {
    if (!this.step2Result) {
      throw new Error("Must call processChallenge before verifyServer");
    }

    const { bigIntToArrayBuffer } = await loadSrp();
    const M2 = hexToBigInt(serverM2);

    try {
      await this.step2Result.step3(M2);

      // Derive session key from S
      const keyBuffer = bigIntToArrayBuffer(this.step2Result.S);
      this.sessionKey = new Uint8Array(keyBuffer);

      return true;
    } catch {
      // Invalid server proof
      return false;
    }
  }

  /**
   * Get the derived session key.
   * Only valid after successful verifyServer.
   *
   * @returns Raw session key bytes, or null if not authenticated
   */
  getSessionKey(): Uint8Array | null {
    return this.sessionKey;
  }

  /**
   * Check if authentication is complete.
   */
  isAuthenticated(): boolean {
    return this.sessionKey !== null;
  }

  /**
   * Get the identity used for authentication.
   */
  getIdentity(): string | null {
    return this.identity;
  }
}
