import { isValidRelayUsername } from "@yep-anywhere/shared";
import type Database from "better-sqlite3";

export interface UsernameRecord {
  username: string;
  install_id: string;
  registered_at: string;
  last_seen_at: string;
}

/**
 * Username registry backed by SQLite.
 *
 * Manages username ownership:
 * - First-come-first-served registration
 * - Same installId can reclaim their username
 * - Different installId is rejected
 * - Inactive usernames can be reclaimed after N days
 */
export class UsernameRegistry {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Check if a username can be registered by the given installId.
   * Returns true if:
   * - Username is not registered, or
   * - Username is registered to this installId
   */
  canRegister(username: string, installId: string): boolean {
    if (!isValidRelayUsername(username)) {
      return false;
    }

    const row = this.db
      .prepare("SELECT install_id FROM usernames WHERE username = ?")
      .get(username) as { install_id: string } | undefined;

    if (!row) {
      return true; // Not registered
    }

    return row.install_id === installId; // Same owner
  }

  /**
   * Register or update a username claim.
   * Updates last_seen_at on every call.
   *
   * @returns true if registration succeeded, false if username is taken by another installId
   */
  register(username: string, installId: string): boolean {
    if (!isValidRelayUsername(username)) {
      return false;
    }

    const now = new Date().toISOString();

    // Check existing registration
    const existing = this.db
      .prepare("SELECT install_id FROM usernames WHERE username = ?")
      .get(username) as { install_id: string } | undefined;

    if (existing) {
      if (existing.install_id !== installId) {
        return false; // Different owner
      }

      // Update last_seen_at for existing owner
      this.db
        .prepare("UPDATE usernames SET last_seen_at = ? WHERE username = ?")
        .run(now, username);
      return true;
    }

    // New registration
    this.db
      .prepare(
        "INSERT INTO usernames (username, install_id, registered_at, last_seen_at) VALUES (?, ?, ?, ?)",
      )
      .run(username, installId, now, now);
    return true;
  }

  /**
   * Update last_seen_at timestamp for a username.
   * Called on activity to prevent reclamation.
   */
  updateLastSeen(username: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE usernames SET last_seen_at = ? WHERE username = ?")
      .run(now, username);
  }

  /**
   * Get a username record.
   */
  get(username: string): UsernameRecord | undefined {
    return this.db
      .prepare("SELECT * FROM usernames WHERE username = ?")
      .get(username) as UsernameRecord | undefined;
  }

  /**
   * Check if a username is registered (by any installId).
   */
  isRegistered(username: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM usernames WHERE username = ?")
      .get(username);
    return row !== undefined;
  }

  /**
   * Delete usernames that haven't been seen in N days.
   * Returns the number of deleted records.
   */
  reclaimInactive(days: number): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffIso = cutoff.toISOString();

    const result = this.db
      .prepare("DELETE FROM usernames WHERE last_seen_at < ?")
      .run(cutoffIso);

    return result.changes;
  }

  /**
   * Delete a username registration.
   * Used for testing or administrative cleanup.
   */
  delete(username: string): boolean {
    const result = this.db
      .prepare("DELETE FROM usernames WHERE username = ?")
      .run(username);
    return result.changes > 0;
  }

  /**
   * Get all registered usernames (for debugging/admin).
   */
  list(): UsernameRecord[] {
    return this.db
      .prepare("SELECT * FROM usernames ORDER BY username")
      .all() as UsernameRecord[];
  }

  /**
   * Get the count of registered usernames.
   */
  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM usernames")
      .get() as { count: number };
    return row.count;
  }
}
