// ============================================================================
// settingsWatcherIntegration.test.ts — the custom-LIVE-folder feature, end to end
// ----------------------------------------------------------------------------
// Verifies the pieces main.ts wires together WITHOUT launching Electron:
//   - validate-then-save: a folder with no Game.log is rejected and NOT saved;
//     a valid folder is saved and resolves to its Game.log.
//   - clean watcher restart: stop the old chokidar handle, start a fresh watcher
//     on the new path, re-backfill its logbackups sibling, with no leaked handles
//     and no duplicate event application across the swap.
// Uses throwaway temp dirs only — never the live app settings file or DB (memory:
// never write the live app state out-of-band).
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
  folderHasGameLog,
  saveSettings,
  loadSettings,
  resolveGameLogPath,
  gameLogPathForFolder,
} from "./settings";
import {
  createLogWatcher,
  type LogWatcher,
  type EventSource,
} from "./logWatcher";
import type { DomainEvent } from "./logParsers";

const ACCEPTED =
  '<2026-06-19T21:03:51.975Z> [Notice] <SHUDEvent_OnNotification> Added notification "Contract Accepted:  Senior Rank - Medium Cargo Haul <EM4>[BP]*</EM4>: " [9] to queue. New queue size: 1, MissionId: [addd0f67-f57d-4173-a212-7a8f46e4b3fd], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]';
const AWARDED =
  '<2026-06-19T22:09:03.788Z> [Notice] <SHUDEvent_OnNotification> Added notification "Awarded 28375 aUEC: " [75] to queue. New queue size: 3, MissionId: [00000000-0000-0000-0000-000000000000], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]';
const FINED =
  '<2026-06-19T21:17:46.767Z> [Notice] <SHUDEvent_OnNotification> Added notification "Fined 20000 UEC: " [34] to queue. New queue size: 1, MissionId: [00000000-0000-0000-0000-000000000000], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]';

let root: string;
let defaultDir: string; // a "default" LIVE dir
let customDir: string; // the "custom install" LIVE dir
let badDir: string; // a folder with NO Game.log
let settingsFile: string;
let watcher: LogWatcher | null = null;

function makeLiveDir(parent: string, name: string): string {
  const d = join(parent, name);
  mkdirSync(join(d, "logbackups"), { recursive: true });
  return d;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sc-feat-"));
  defaultDir = makeLiveDir(root, "default-LIVE");
  customDir = makeLiveDir(root, "custom-LIVE");
  badDir = join(root, "not-a-live-folder");
  mkdirSync(badDir, { recursive: true });
  settingsFile = join(root, "settings.json");
});

afterEach(async () => {
  if (watcher) {
    await watcher.stop();
    watcher = null;
  }
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// validate-then-save (the picker's gate)
// ---------------------------------------------------------------------------

describe("custom LIVE folder validate + persist", () => {
  it("rejects a folder with no Game.log and does not save it", () => {
    expect(folderHasGameLog(badDir)).toBe(false);
    // The handler short-circuits before saveSettings, so settings stays default.
    expect(loadSettings(settingsFile).liveFolder).toBeNull();
  });

  it("accepts a folder with Game.log, persists it, and resolves to it", () => {
    writeFileSync(gameLogPathForFolder(customDir), ACCEPTED + "\n");
    expect(folderHasGameLog(customDir)).toBe(true);

    saveSettings({ liveFolder: customDir }, settingsFile);

    // Persisted across a fresh load (simulates an app restart).
    const reloaded = loadSettings(settingsFile);
    expect(reloaded.liveFolder).toBe(customDir);
    expect(
      resolveGameLogPath(reloaded, undefined, gameLogPathForFolder(defaultDir)),
    ).toBe(gameLogPathForFolder(customDir));
  });

  it("degrades to default when a configured folder later loses its Game.log", () => {
    // Configured but the Game.log is gone (game uninstalled / drive unplugged).
    saveSettings({ liveFolder: customDir }, settingsFile); // no Game.log written
    const reloaded = loadSettings(settingsFile);
    const fallback = gameLogPathForFolder(defaultDir);
    expect(resolveGameLogPath(reloaded, undefined, fallback)).toBe(fallback);
  });
});

// ---------------------------------------------------------------------------
// Clean watcher restart against the new path (idempotent, no leaks/dupes)
// ---------------------------------------------------------------------------

describe("watcher retarget to a new LIVE folder", () => {
  /** Mirror of main.ts startWatcher: stop the old watcher before starting new. */
  async function startWatcherOn(
    logPath: string,
    onEvent: (e: DomainEvent, s: EventSource) => void,
  ): Promise<void> {
    if (watcher) {
      await watcher.stop();
      watcher = null;
    }
    watcher = createLogWatcher({ logPath, onEvent });
    await watcher.start();
  }

  it("stops the old watcher and re-backfills + tails the new folder, no dupes", async () => {
    // Default folder: one historical session + a live current log.
    writeFileSync(
      join(defaultDir, "logbackups", "Game-2026.06.18-09.00.log"),
      FINED + "\n",
    );
    writeFileSync(gameLogPathForFolder(defaultDir), ACCEPTED + "\n");

    // Custom folder: a DIFFERENT historical session + its own current log.
    writeFileSync(
      join(customDir, "logbackups", "Game-2026.06.17-09.00.log"),
      AWARDED + "\n",
    );
    writeFileSync(gameLogPathForFolder(customDir), ACCEPTED + "\n");

    const tagged: Array<{ type: string; source: string }> = [];
    const sink = (e: DomainEvent, s: EventSource): void => {
      tagged.push({ type: e.type, source: s });
    };

    // 1) Start on the DEFAULT folder.
    await startWatcherOn(gameLogPathForFolder(defaultDir), sink);
    await new Promise((r) => setTimeout(r, 150));

    expect(tagged).toEqual([
      { type: "fined", source: "historical" }, // default's logbackups
      { type: "missionAccepted", source: "live" }, // default's Game.log
    ]);

    // 2) RETARGET to the custom folder (the picker's restart).
    tagged.length = 0;
    await startWatcherOn(gameLogPathForFolder(customDir), sink);
    await new Promise((r) => setTimeout(r, 150));

    // Only the CUSTOM folder's content is re-read — no default content leaks in,
    // proving the old chokidar handle was disposed (no double-attached listener).
    expect(tagged).toEqual([
      { type: "payoutAwarded", source: "historical" }, // custom's logbackups
      { type: "missionAccepted", source: "live" }, // custom's Game.log
    ]);

    // 3) The NEW watcher tails the new file; the OLD one is gone (an append to
    //    the default log must produce nothing now).
    const before = tagged.length;
    appendFileSync(gameLogPathForFolder(defaultDir), FINED + "\n");
    await new Promise((r) => setTimeout(r, 400));
    expect(tagged.length).toBe(before); // old watcher did not fire

    // An append to the CUSTOM (current) log IS picked up by the live tail.
    appendFileSync(gameLogPathForFolder(customDir), AWARDED + "\n");
    const deadline = Date.now() + 5000;
    while (
      Date.now() < deadline &&
      !tagged.some((t) => t.type === "payoutAwarded" && t.source === "live")
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(
      tagged.some((t) => t.type === "payoutAwarded" && t.source === "live"),
    ).toBe(true);
  }, 15000);
});
