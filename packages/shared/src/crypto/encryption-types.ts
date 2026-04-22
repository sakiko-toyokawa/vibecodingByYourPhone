/**
 * Encrypted message envelope for relay traffic.
 *
 * All messages after SRP handshake are wrapped in this format.
 * Uses NaCl secretbox (XSalsa20-Poly1305).
 */

/** Encrypted message wrapper */
export interface EncryptedEnvelope {
  type: "encrypted";
  /** Random 24-byte nonce (base64) */
  nonce: string;
  /** Encrypted payload (base64) */
  ciphertext: string;
}

/**
 * Sequenced encrypted payload.
 * The payload is encrypted end-to-end and carries a monotonically increasing
 * sequence number per connection to detect same-connection replay.
 */
export interface SequencedEncryptedPayload<T = unknown> {
  seq: number;
  msg: T;
}

/** Type guard for encrypted envelope */
export function isEncryptedEnvelope(msg: unknown): msg is EncryptedEnvelope {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as EncryptedEnvelope).type === "encrypted" &&
    typeof (msg as EncryptedEnvelope).nonce === "string" &&
    typeof (msg as EncryptedEnvelope).ciphertext === "string"
  );
}

/** Type guard for sequenced encrypted payload wrapper. */
export function isSequencedEncryptedPayload(
  msg: unknown,
): msg is SequencedEncryptedPayload<unknown> {
  return (
    typeof msg === "object" &&
    msg !== null &&
    Number.isSafeInteger((msg as SequencedEncryptedPayload).seq) &&
    (msg as SequencedEncryptedPayload).seq >= 0 &&
    "msg" in (msg as SequencedEncryptedPayload)
  );
}
