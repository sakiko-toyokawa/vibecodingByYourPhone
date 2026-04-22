import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countEntries,
  deleteEntries,
  getAllEntries,
  openDatabase,
  putEntry,
} from "../idb";

const DB_NAME = "test-idb";
const STORE_NAME = "items";

describe("idb helpers", () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    db = await openDatabase(DB_NAME, 1, (database) => {
      database.createObjectStore(STORE_NAME, {
        keyPath: "id",
        autoIncrement: true,
      });
    });
  });

  afterEach(() => {
    db.close();
    // Delete the database between tests
    indexedDB.deleteDatabase(DB_NAME);
  });

  it("opens a database and creates a store", () => {
    expect(db).toBeDefined();
    expect(db.objectStoreNames.contains(STORE_NAME)).toBe(true);
  });

  it("puts and retrieves entries", async () => {
    const key = await putEntry(db, STORE_NAME, { value: "hello" });
    expect(key).toBe(1);

    const entries = await getAllEntries<{ id: number; value: string }>(
      db,
      STORE_NAME,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.value).toBe("hello");
  });

  it("retrieves entries with count limit", async () => {
    await putEntry(db, STORE_NAME, { value: "a" });
    await putEntry(db, STORE_NAME, { value: "b" });
    await putEntry(db, STORE_NAME, { value: "c" });

    const limited = await getAllEntries<{ id: number; value: string }>(
      db,
      STORE_NAME,
      2,
    );
    expect(limited).toHaveLength(2);
    expect(limited[0]?.value).toBe("a");
    expect(limited[1]?.value).toBe("b");
  });

  it("counts entries", async () => {
    expect(await countEntries(db, STORE_NAME)).toBe(0);

    await putEntry(db, STORE_NAME, { value: "a" });
    await putEntry(db, STORE_NAME, { value: "b" });

    expect(await countEntries(db, STORE_NAME)).toBe(2);
  });

  it("deletes entries by key", async () => {
    await putEntry(db, STORE_NAME, { value: "a" });
    await putEntry(db, STORE_NAME, { value: "b" });
    await putEntry(db, STORE_NAME, { value: "c" });

    await deleteEntries(db, STORE_NAME, [1, 3]);

    const remaining = await getAllEntries<{ id: number; value: string }>(
      db,
      STORE_NAME,
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.value).toBe("b");
  });

  it("handles empty delete gracefully", async () => {
    await deleteEntries(db, STORE_NAME, []);
    expect(await countEntries(db, STORE_NAME)).toBe(0);
  });
});
