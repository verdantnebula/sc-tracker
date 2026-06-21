// ============================================================================
// db/recovery.test.ts — corruption detection + recover-and-rebuild (Phase 2)
// ----------------------------------------------------------------------------
// Proves the reliability fix WITHOUT touching the live app db:
//   - isCorruptionError() correctly classifies SQLITE_CORRUPT-class errors and
//     rejects unrelated errors.
//   - integrityIsBad() flags a deliberately-corrupted db file and passes a clean
//     one.
//   - openDbResilient() / the MissionStore open path quarantines a corrupt file
//     aside and rebuilds a fresh, working db.
//   - store.guard() recovers from a corruption thrown at runtime.
//
// All file I/O happens in a throwaway temp dir — the live db is never opened.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
  isCorruptionError,
  integrityIsBad,
  quarantineDbFiles,
  openDbResilient,
} from "./recovery";
import { createDb } from "./schema";
import {
  openMissionStore,
  DatabaseRecoveredError,
  type MissionStore,
} from "../missionStore";
import type { DomainEvent } from "@shared/events";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sc-recovery-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** Write a file that is NOT a valid sqlite database at `path`. */
function writeGarbageDb(path: string): void {
  // A valid sqlite file starts with the 16-byte "SQLite format 3\0" header.
  // Garbage bytes guarantee "file is not a database" / malformed on open.
  writeFileSync(
    path,
    Buffer.from("this is definitely not a sqlite database\n".repeat(50)),
  );
}

/**
 * Build a real sqlite db then corrupt its page data in place (keep the header so
 * it opens, but quick_check / a query trips on the malformed image). We overwrite
 * a swath of the file body with garbage.
 */
function writeHeaderValidButCorruptDb(path: string): void {
  const db = createDb(path);
  // Put enough data in to span multiple pages.
  const insert = db.prepare(
    "INSERT INTO missions (id, created_seq) VALUES (?, ?)",
  );
  const tx = db.transaction(() => {
    for (let i = 0; i < 500; i++) insert.run(`m${i}`, i);
  });
  tx();
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();

  // Corrupt the body: keep the first 32 bytes (header), trash the rest.
  const buf = readFileSync(path);
  for (let i = 32; i < buf.length; i++) buf[i] = 0xff;
  writeFileSync(path, buf);
}

// ---------------------------------------------------------------------------

describe("isCorruptionError", () => {
  it("classifies SQLITE_CORRUPT by code", () => {
    expect(isCorruptionError({ code: "SQLITE_CORRUPT" })).toBe(true);
    expect(isCorruptionError({ code: "SQLITE_CORRUPT_VTAB" })).toBe(true);
    expect(isCorruptionError({ code: "SQLITE_NOTADB" })).toBe(true);
  });

  it("classifies the malformed/not-a-database messages", () => {
    expect(
      isCorruptionError(new Error("database disk image is malformed")),
    ).toBe(true);
    expect(isCorruptionError(new Error("file is not a database"))).toBe(true);
  });

  it("rejects unrelated errors (does not mask real bugs)", () => {
    expect(isCorruptionError(new Error("mission not found: x"))).toBe(false);
    expect(isCorruptionError({ code: "SQLITE_BUSY" })).toBe(false);
    expect(isCorruptionError(null)).toBe(false);
    expect(isCorruptionError(undefined)).toBe(false);
    expect(isCorruptionError("just a string")).toBe(false);
  });
});

describe("integrityIsBad", () => {
  it("passes a clean db", () => {
    const path = join(dir, "clean.db");
    const db = createDb(path);
    expect(integrityIsBad(db)).toBe(false);
    db.close();
  });

  it("flags a header-valid but body-corrupt db", () => {
    const path = join(dir, "bad.db");
    writeHeaderValidButCorruptDb(path);
    // Opening may or may not throw depending on which page is read first; the
    // integrity check is the reliable signal. Open raw (no integrity gate).
    const db = new Database(path);
    let bad: boolean;
    try {
      bad = integrityIsBad(db);
    } catch (err) {
      // A corruption thrown by the pragma itself also means "bad".
      bad = isCorruptionError(err);
    }
    expect(bad).toBe(true);
    try {
      db.close();
    } catch {
      /* corrupt handle */
    }
  });
});

describe("quarantineDbFiles", () => {
  it("renames the db + sidecars aside and returns the target base", () => {
    const path = join(dir, "q.db");
    writeFileSync(path, "x");
    writeFileSync(path + "-wal", "y");
    writeFileSync(path + "-shm", "z");

    const target = quarantineDbFiles(path);
    expect(target).toBe(path + ".corrupt-1");
    expect(existsSync(path)).toBe(false);
    expect(existsSync(path + "-wal")).toBe(false);
    expect(existsSync(target!)).toBe(true);
    expect(existsSync(target! + "-wal")).toBe(true);
    expect(existsSync(target! + "-shm")).toBe(true);
  });

  it("picks an un-used numeric suffix on repeat (forensic copies kept)", () => {
    const path = join(dir, "q2.db");
    writeFileSync(path, "a");
    const first = quarantineDbFiles(path);
    writeFileSync(path, "b");
    const second = quarantineDbFiles(path);
    expect(first).toBe(path + ".corrupt-1");
    expect(second).toBe(path + ".corrupt-2");
    expect(existsSync(first!)).toBe(true);
    expect(existsSync(second!)).toBe(true);
  });

  it("is a no-op for :memory:", () => {
    expect(quarantineDbFiles(":memory:")).toBeNull();
  });
});

describe("openDbResilient", () => {
  it("opens a clean db without recovering", () => {
    const path = join(dir, "ok.db");
    const result = openDbResilient(path, (p) => createDb(p));
    expect(result.recovered).toBe(false);
    expect(result.quarantinedTo).toBeNull();
    expect(integrityIsBad(result.db)).toBe(false);
    result.db.close();
  });

  it("recovers from a not-a-database file: quarantines + rebuilds working db", () => {
    const path = join(dir, "garbage.db");
    writeGarbageDb(path);

    let recoveredTo: string | null | undefined;
    const result = openDbResilient(
      path,
      (p) => createDb(p),
      (info) => {
        recoveredTo = info.quarantinedTo;
      },
    );

    expect(result.recovered).toBe(true);
    expect(result.quarantinedTo).toBe(path + ".corrupt-1");
    expect(recoveredTo).toBe(path + ".corrupt-1");
    // Forensic copy kept; fresh db works.
    expect(existsSync(path + ".corrupt-1")).toBe(true);
    expect(integrityIsBad(result.db)).toBe(false);
    // The fresh db is usable.
    result.db
      .prepare("INSERT INTO missions (id, created_seq) VALUES (?, ?)")
      .run("fresh", 1);
    const n = result.db.prepare("SELECT COUNT(*) AS c FROM missions").get() as {
      c: number;
    };
    expect(n.c).toBe(1);
    result.db.close();
  });

  it("recovers from a header-valid but body-corrupt db", () => {
    const path = join(dir, "corrupt.db");
    writeHeaderValidButCorruptDb(path);
    const result = openDbResilient(path, (p) => createDb(p));
    expect(result.recovered).toBe(true);
    expect(integrityIsBad(result.db)).toBe(false);
    result.db.close();
  });

  it("rethrows a non-corruption error from the opener (no false recovery)", () => {
    const path = join(dir, "boom.db");
    expect(() =>
      openDbResilient(path, () => {
        throw new Error("disk full or some other real failure");
      }),
    ).toThrow("disk full");
    // Nothing was quarantined.
    expect(existsSync(path + ".corrupt-1")).toBe(false);
  });
});

describe("MissionStore corruption recovery (open path)", () => {
  let store: MissionStore;
  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
  });

  it("auto-recovers a corrupt db on open and reports wasRecovered()", () => {
    const path = join(dir, "store.db");
    writeGarbageDb(path);

    let recoverNoticed: string | null | undefined;
    store = openMissionStore({
      dbPath: path,
      onRecover: (q) => {
        recoverNoticed = q;
      },
    });

    expect(store.wasRecovered()).toBe(true);
    expect(recoverNoticed).toBe(path + ".corrupt-1");
    expect(existsSync(path + ".corrupt-1")).toBe(true);

    // The recovered (empty) store is fully functional: applying events works and
    // the data repopulates (simulating the backfill main.ts runs after recovery).
    const accepted: DomainEvent = {
      type: "missionAccepted",
      missionId: "x1",
      title: "Test haul",
      ts: 1000,
    };
    store.applyEvent(accepted, "live");
    expect(store.listMissions()).toHaveLength(1);
  });

  it("a clean db opens without recovery", () => {
    const path = join(dir, "store-clean.db");
    store = openMissionStore({ dbPath: path });
    expect(store.wasRecovered()).toBe(false);
  });
});

describe("MissionStore.guard (runtime corruption)", () => {
  it("recovers + throws DatabaseRecoveredError when fn throws corruption", () => {
    const path = join(dir, "guard.db");
    const store = openMissionStore({ dbPath: path });
    expect(store.wasRecovered()).toBe(false);

    // Simulate a SQLITE_CORRUPT thrown during an operation.
    const corruptErr = Object.assign(
      new Error("database disk image is malformed"),
      {
        code: "SQLITE_CORRUPT",
      },
    );

    expect(() =>
      store.guard(() => {
        throw corruptErr;
      }),
    ).toThrow(DatabaseRecoveredError);

    // After recovery the store is usable again and the bad file was quarantined.
    expect(store.wasRecovered()).toBe(true);
    expect(existsSync(path + ".corrupt-1")).toBe(true);
    store.applyEvent(
      { type: "missionAccepted", missionId: "y1", title: "After", ts: 1 },
      "live",
    );
    expect(store.listMissions()).toHaveLength(1);
    store.close();
  });

  it("passes through a non-corruption error untouched (no false recovery)", () => {
    const path = join(dir, "guard2.db");
    const store = openMissionStore({ dbPath: path });
    expect(() =>
      store.guard(() => {
        throw new Error("ordinary bug");
      }),
    ).toThrow("ordinary bug");
    expect(store.wasRecovered()).toBe(false);
    store.close();
  });
});
