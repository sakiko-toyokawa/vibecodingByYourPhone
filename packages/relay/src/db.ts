import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

/**
 * Creates and initializes the SQLite database for username registry.
 *
 * Schema:
 * - usernames: Maps usernames to installation IDs with timestamps
 */
export function createDb(dataDir: string): Database.Database {
  // Ensure data directory exists
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = join(dataDir, "relay.db");
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");

  // Create usernames table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS usernames (
      username TEXT PRIMARY KEY,
      install_id TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )
  `);

  // Create index on last_seen_at for efficient reclamation queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_usernames_last_seen
    ON usernames(last_seen_at)
  `);

  return db;
}

/**
 * Creates an in-memory database for testing.
 */
export function createTestDb(): Database.Database {
  const db = new Database(":memory:");

  db.exec(`
    CREATE TABLE IF NOT EXISTS usernames (
      username TEXT PRIMARY KEY,
      install_id TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_usernames_last_seen
    ON usernames(last_seen_at)
  `);

  return db;
}
