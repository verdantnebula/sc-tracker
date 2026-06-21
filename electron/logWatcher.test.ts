// ============================================================================
// logWatcher.test.ts — watcher behavior (SPEC §4, §9)
// ----------------------------------------------------------------------------
// Covers the deterministic pieces: pure chunk parsing, backup ordering, the
// backfill scan (oldest->newest, progress reporting), and the live offset-delta
// tail incl. truncation/rotation reset. chokidar fs-event timing is inherently
// async, so live-tail assertions poll with a bounded timeout.
// ============================================================================

import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createLogWatcher,
  parseChunk,
  sortBackupsOldestFirst,
  DEFAULT_GAME_LOG_PATH,
  type LogWatcher,
} from "./logWatcher";
import type { DomainEvent } from "./logParsers";
import type { BackfillProgress } from "@shared/types";

// --- Sample real log lines (subset of fixtures/sample-events.log) -----------

const ACCEPTED =
  '<2026-06-19T21:03:51.975Z> [Notice] <SHUDEvent_OnNotification> Added notification "Contract Accepted:  Senior Rank - Medium Cargo Haul <EM4>[BP]*</EM4>: " [9] to queue. New queue size: 1, MissionId: [addd0f67-f57d-4173-a212-7a8f46e4b3fd], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]';
const AWARDED =
  '<2026-06-19T22:09:03.788Z> [Notice] <SHUDEvent_OnNotification> Added notification "Awarded 28375 aUEC: " [75] to queue. New queue size: 3, MissionId: [00000000-0000-0000-0000-000000000000], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]';
const FINED =
  '<2026-06-19T21:17:46.767Z> [Notice] <SHUDEvent_OnNotification> Added notification "Fined 20000 UEC: " [34] to queue. New queue size: 1, MissionId: [00000000-0000-0000-0000-000000000000], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]';

// --- Temp dir scaffolding ---------------------------------------------------

let dir: string;
let logPath: string;
let backupsDir: string;
let watcher: LogWatcher | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sc-log-"));
  logPath = join(dir, "Game.log");
  backupsDir = join(dir, "logbackups");
  mkdirSync(backupsDir);
});

afterEach(async () => {
  if (watcher) {
    await watcher.stop();
    watcher = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Poll a predicate until true or timeout (chokidar events are async). */
async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!pred()) throw new Error("waitFor timed out");
}

/**
 * chokidar's polling watcher needs a moment after start() to establish its
 * baseline stat of the file before it can detect a subsequent write. In
 * production the live game log writes continuously so this window is harmless;
 * in tests we explicitly wait for the poller to arm before appending.
 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 500));
}

// ---------------------------------------------------------------------------
// parseChunk
// ---------------------------------------------------------------------------

describe("parseChunk", () => {
  it("parses multiple newline-separated lines, skipping noise/blanks", () => {
    const text = [ACCEPTED, "", "garbage line no timestamp", AWARDED].join(
      "\n",
    );
    const events = parseChunk(text);
    expect(events.map((e) => e.type)).toEqual([
      "missionAccepted",
      "payoutAwarded",
    ]);
  });

  it("returns [] for empty input", () => {
    expect(parseChunk("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sortBackupsOldestFirst
// ---------------------------------------------------------------------------

describe("sortBackupsOldestFirst", () => {
  it("orders timestamped backup names lexically (= chronologically)", () => {
    const files = [
      "Game-2026.06.19-10.00.log",
      "Game-2026.06.18-09.00.log",
      "Game-2026.06.19-08.00.log",
    ];
    const sorted = sortBackupsOldestFirst(backupsDir, files);
    expect(sorted).toEqual([
      "Game-2026.06.18-09.00.log",
      "Game-2026.06.19-08.00.log",
      "Game-2026.06.19-10.00.log",
    ]);
  });
});

// ---------------------------------------------------------------------------
// default path
// ---------------------------------------------------------------------------

describe("default Game.log path", () => {
  it("exposes the LIVE default and is overridable via options", () => {
    expect(DEFAULT_GAME_LOG_PATH).toContain("StarCitizen/LIVE/Game.log");
  });
});

// ---------------------------------------------------------------------------
// backfill
// ---------------------------------------------------------------------------

describe("backfill", () => {
  it("reads logbackups oldest->newest, emits parsed events, reports done", async () => {
    writeFileSync(join(backupsDir, "Game-2026.06.18-09.00.log"), FINED + "\n");
    writeFileSync(
      join(backupsDir, "Game-2026.06.19-10.00.log"),
      ACCEPTED + "\n",
    );

    const events: DomainEvent[] = [];
    const progress: BackfillProgress[] = [];
    watcher = createLogWatcher({
      logPath,
      onEvent: (e) => events.push(e),
      onBackfillProgress: (p) => progress.push(p),
    });

    await watcher.backfill();

    // Oldest backup first -> fined before missionAccepted.
    expect(events.map((e) => e.type)).toEqual(["fined", "missionAccepted"]);
    expect(progress.at(-1)?.done).toBe(true);
    expect(progress.at(-1)?.progress).toBe(100);
  });

  it("handles an absent/empty logbackups dir without throwing", async () => {
    rmSync(backupsDir, { recursive: true, force: true });
    const progress: BackfillProgress[] = [];
    watcher = createLogWatcher({
      logPath,
      onEvent: () => {},
      onBackfillProgress: (p) => progress.push(p),
    });
    await expect(watcher.backfill()).resolves.toBeUndefined();
    expect(progress.at(-1)?.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// live tail — offset delta + rotation
// ---------------------------------------------------------------------------

describe("live tail", () => {
  it("reads the CURRENT Game.log from offset 0 on start, tagged 'live'", async () => {
    // The current Game.log already holds a mission accepted BEFORE the app
    // launched this session. That is the current session and MUST be captured as
    // 'live' so it surfaces as an active mission (regression: previously the
    // offset was seeded to EOF and this content was skipped entirely).
    writeFileSync(logPath, ACCEPTED + "\n");

    const events: DomainEvent[] = [];
    const sources: string[] = [];
    watcher = createLogWatcher({
      logPath,
      onEvent: (e, source) => {
        events.push(e);
        sources.push(source);
      },
    });
    await watcher.start();

    await new Promise((r) => setTimeout(r, 150));
    expect(events.map((e) => e.type)).toEqual(["missionAccepted"]);
    expect(sources).toEqual(["live"]);
  });

  it("tags logbackups events 'historical' and does not duplicate the live read", async () => {
    // A past session in logbackups + a current Game.log. Backfill -> historical,
    // current log read -> live. No event is emitted twice.
    writeFileSync(join(backupsDir, "Game-2026.06.18-09.00.log"), FINED + "\n");
    writeFileSync(logPath, ACCEPTED + "\n");

    const tagged: Array<{ type: string; source: string }> = [];
    watcher = createLogWatcher({
      logPath,
      onEvent: (e, source) => tagged.push({ type: e.type, source }),
    });
    await watcher.start();
    await new Promise((r) => setTimeout(r, 150));

    expect(tagged).toEqual([
      { type: "fined", source: "historical" },
      { type: "missionAccepted", source: "live" },
    ]);
  });

  it("emits events for lines appended after start (delta read)", async () => {
    writeFileSync(logPath, ACCEPTED + "\n");
    const events: DomainEvent[] = [];
    watcher = createLogWatcher({ logPath, onEvent: (e) => events.push(e) });
    await watcher.start();
    await settle();

    appendFileSync(logPath, AWARDED + "\n");
    await waitFor(() => events.some((e) => e.type === "payoutAwarded"));

    // The pre-existing ACCEPTED is read once on start (offset 0); the appended
    // AWARDED is picked up by the delta tail. Each appears exactly once.
    expect(events.map((e) => e.type)).toEqual([
      "missionAccepted",
      "payoutAwarded",
    ]);
  }, 10000);

  it("resets to offset 0 on truncation/rotation and re-reads the new content", async () => {
    writeFileSync(logPath, ACCEPTED + "\n" + AWARDED + "\n");
    const events: DomainEvent[] = [];
    watcher = createLogWatcher({ logPath, onEvent: (e) => events.push(e) });
    await watcher.start();
    await settle();

    // The pre-existing session content is read once on start (offset 0).
    expect(events.map((e) => e.type)).toEqual([
      "missionAccepted",
      "payoutAwarded",
    ]);

    // Simulate a game restart: file truncated and a fresh, shorter session begins.
    writeFileSync(logPath, FINED + "\n");
    await waitFor(() => events.some((e) => e.type === "fined"));

    // After truncation the new (shorter) content is re-read from 0 -> 'fined'
    // is appended; no spurious re-replay of the prior session's events.
    expect(events.map((e) => e.type)).toEqual([
      "missionAccepted",
      "payoutAwarded",
      "fined",
    ]);
  }, 10000);

  it("reports a connected status once watching a present file", async () => {
    writeFileSync(logPath, "");
    watcher = createLogWatcher({ logPath, onEvent: () => {} });
    await watcher.start();
    expect(watcher.status().state).toBe("connected");
    expect(watcher.status().logPath).toBe(logPath);
  });
});
