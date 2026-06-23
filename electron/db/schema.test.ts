// ============================================================================
// schema.test.ts — schema version + the v6 `missions.reward` migration.
// ----------------------------------------------------------------------------
// Verifies a fresh db is at SCHEMA_VERSION with the reward column, and that an
// OLD pre-v6 cargo db (built without `reward`) upgrades ADDITIVELY on next open:
// the column is added (nullable, NULL on existing rows) and no data is lost.
// ============================================================================

import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { createDb, SCHEMA_VERSION } from "./schema";

const tmpFiles: string[] = [];
function tmpDbPath(tag: string): string {
  const p = join(
    tmpdir(),
    `sc-schema-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const p of tmpFiles.splice(0)) {
    for (const ext of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(p + ext);
      } catch {
        /* ignore */
      }
    }
  }
});

describe("schema version", () => {
  it("is 6", () => {
    expect(SCHEMA_VERSION).toBe(6);
  });

  it("a fresh db reports user_version === SCHEMA_VERSION and has missions.reward", () => {
    const db = createDb(":memory:");
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      const cols = (
        db.prepare("PRAGMA table_info(missions)").all() as Array<{
          name: string;
        }>
      ).map((c) => c.name);
      expect(cols).toContain("reward");
    } finally {
      db.close();
    }
  });
});

describe("v6 migration: missions.reward", () => {
  it("adds the reward column to a pre-v6 db without losing data, defaulting NULL", () => {
    const path = tmpDbPath("migrate");

    // Build a pre-v6 cargo db BY HAND: a missions table WITHOUT the reward
    // column, one row inserted, user_version stamped to 5. This is exactly the
    // on-disk shape a v1.5.0 install would have.
    const old = new Database(path);
    old.exec(`
      CREATE TABLE missions (
        id                TEXT PRIMARY KEY,
        title             TEXT NOT NULL DEFAULT '',
        giver             TEXT NOT NULL DEFAULT '',
        variant           TEXT NOT NULL DEFAULT 'MANUAL',
        grade             TEXT NOT NULL DEFAULT 'UNKNOWN',
        contract_template TEXT,
        contract_definition_id TEXT,
        status            TEXT NOT NULL DEFAULT 'accepted',
        payout            INTEGER,
        payout_confidence TEXT NOT NULL DEFAULT 'unknown',
        source            TEXT NOT NULL DEFAULT 'log',
        accepted_at       INTEGER,
        completed_at      INTEGER,
        notes             TEXT NOT NULL DEFAULT '',
        created_seq       INTEGER,
        title_pickup      TEXT,
        title_dropoff     TEXT,
        session           TEXT NOT NULL DEFAULT 'historical'
      );
    `);
    old
      .prepare(
        `INSERT INTO missions (id, title, payout, payout_confidence)
       VALUES ('old-1', 'Pre-v6 haul', 50000, 'confirmed')`,
      )
      .run();
    // Sanity: the old db genuinely lacks the reward column.
    const oldCols = (
      old.prepare("PRAGMA table_info(missions)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(oldCols).not.toContain("reward");
    old.pragma("user_version = 5");
    old.close();

    // Re-open via createDb -> the additive migration runs.
    const db = createDb(path);
    try {
      const cols = (
        db.prepare("PRAGMA table_info(missions)").all() as Array<{
          name: string;
        }>
      ).map((c) => c.name);
      expect(cols).toContain("reward");
      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);

      // Existing row survived and its reward is NULL (additive default).
      const row = db
        .prepare(
          "SELECT id, title, payout, reward FROM missions WHERE id = 'old-1'",
        )
        .get() as {
        id: string;
        title: string;
        payout: number;
        reward: number | null;
      };
      expect(row.title).toBe("Pre-v6 haul");
      expect(row.payout).toBe(50000);
      expect(row.reward).toBeNull();
    } finally {
      db.close();
    }
  });
});
