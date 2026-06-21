// ============================================================================
// realLogE2E.test.ts — END-TO-END reconstruction proof against a BUNDLED,
// SANITIZED Game.log fixture (fixtures/e2e-sample.log).
// ----------------------------------------------------------------------------
// This is the integration proof that the wired app reconstructs missions from
// real-shaped log data (SPEC §9 "Integration"). It runs on ANY machine — it
// reads only a checked-in fixture of representative, scrubbed log lines (no
// player name, no player id, no personal data), feeds them through the SAME
// pipeline main.ts wires —
//   parseLine() (logWatcher.parseChunk) -> missionStore.applyEvent()
// — and asserts the mission facts that fixture encodes.
//
// The fixture mixes the documented Game.log event types: Contract Accepted,
// CreateMarker (giver/template/variant/grade + objective positions), New
// Objective Deliver (per-leg commodity/SCU/destination), ObjectiveUpserted /
// ObjectiveComplete (per-objective completion), EndMission CompletionType
// (terminal state) and "Awarded N aUEC" (payout, correlated by timestamp). It
// deliberately includes a RedWind mission with NO "New Objective" line to
// exercise the intermittent-suppression fallback path.
// ============================================================================

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseChunk } from "./logWatcher";
import { openMissionStore, type MissionStore } from "./missionStore";
import type { Mission } from "@shared/types";

const FIXTURE = resolve(__dirname, "../fixtures/e2e-sample.log");

// =============================================================================
// Deterministic integration proof of the bug fix (runs on ANY machine — no live
// log required). Mirrors the real pollution scenario: logbackups (PAST sessions)
// contain MANY missions that never logged a terminal EndMission, plus some that
// completed; the current Game.log (live) holds a couple of freshly-accepted
// missions. Drives the SAME pipeline as main.ts: parseChunk -> applyEvent(source).
// =============================================================================

// A real "Contract Accepted" notification line for a given missionId/title.
const acceptedLine = (id: string, title: string, ts: string): string =>
  `<${ts}> [Notice] <SHUDEvent_OnNotification> Added notification "Contract Accepted:  ${title} <EM4>[BP]*</EM4>: " [9] to queue. New queue size: 1, MissionId: [${id}], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]`;

// A real "EndMission" terminal line.
const endLine = (
  id: string,
  completion: "Complete" | "Abandon",
  ts: string,
): string =>
  `<${ts}> [Notice] <EndMission> Mission ended MissionId[${id}] CompletionType[${completion}] Reason[Finished] [Team_CoreGameplayFeatures][Missions]`;

describe("bug fix — historical non-terminal missions are not 'active'", () => {
  it("backfilled never-terminated missions are excluded; live ones are active", () => {
    const store = openMissionStore({ dbPath: ":memory:" });

    // PAST session #1 (logbackups -> historical): 5 missions accepted, NONE ended
    // (the exact bug: no logged EndMission -> stuck accepted forever).
    const histStuck: string[] = [];
    for (let i = 0; i < 5; i++) {
      histStuck.push(
        acceptedLine(
          `old-stuck-${i}-0000-0000-0000-000000000000`,
          `Old Stuck Haul ${i}`,
          `2026-05-0${i + 1}T10:00:00.000Z`,
        ),
      );
    }
    // PAST session #2 (historical): 3 missions that DID complete -> belong in History.
    const histDone: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = `old-done-${i}-0000-0000-0000-000000000000`;
      histDone.push(
        acceptedLine(id, `Old Done Haul ${i}`, `2026-05-1${i}T10:00:00.000Z`),
      );
      histDone.push(endLine(id, "Complete", `2026-05-1${i}T11:00:00.000Z`));
    }

    // CURRENT session (live Game.log read from offset 0): 2 freshly-accepted,
    // still-active missions.
    const liveActive: string[] = [];
    for (let i = 0; i < 2; i++) {
      liveActive.push(
        acceptedLine(
          `live-${i}-0000-0000-0000-000000000000`,
          `Live Haul ${i}`,
          `2026-06-19T20:0${i}:00.000Z`,
        ),
      );
    }

    // Feed historical first (backfill), then live (current log) — exactly start().
    for (const e of parseChunk(histStuck.join("\n")))
      store.applyEvent(e, "historical");
    for (const e of parseChunk(histDone.join("\n")))
      store.applyEvent(e, "historical");
    for (const e of parseChunk(liveActive.join("\n")))
      store.applyEvent(e, "live");

    const all = store.listMissions();
    const active = store.activeMissions();
    const history = store.history();

    // 10 missions total reconstructed (5 stuck + 3 done + 2 live).
    expect(all.length).toBe(10);
    // ONLY the 2 live, non-terminal missions are active — the 5 stuck historical
    // ones are correctly excluded (this is the bug being fixed).
    expect(active.length).toBe(2);
    expect(active.every((m) => m.id.startsWith("live-"))).toBe(true);
    // History holds the 3 completed historical hauls (not the stuck ones).
    expect(history.length).toBe(3);
    expect(history.every((m) => m.id.startsWith("old-done-"))).toBe(true);

    // eslint-disable-next-line no-console
    console.log(
      `\n[bugfix-proof] total=${all.length} active=${active.length} ` +
        `history=${history.length} (5 stuck historical correctly NOT active)`,
    );

    // Clear empties active, keeps history.
    expect(store.clearActiveMissions()).toBe(2);
    expect(store.activeMissions().length).toBe(0);
    expect(store.history().length).toBe(3);

    // Reset wipes everything.
    store.resetAllData();
    expect(store.listMissions().length).toBe(0);
    store.close();
  });
});

describe("fixture end-to-end reconstruction", () => {
  let store: MissionStore;
  let missions: Mission[];
  let eventCount = 0;

  beforeAll(() => {
    const text = readFileSync(FIXTURE, "utf8");
    const events = parseChunk(text);
    eventCount = events.length;

    // In-memory store; feed every parsed event through the real pipeline as the
    // live session (single bundled fixture represents one capture).
    store = openMissionStore({ dbPath: ":memory:" });
    for (const e of events) store.applyEvent(e, "live");

    missions = store.listMissions();
  });

  // Helper: find a mission whose id starts with the known short prefix.
  const find = (prefix: string): Mission | undefined =>
    missions.find((m) => m.id.startsWith(prefix));

  it("parses every event from the fixture and reconstructs all missions", () => {
    expect(eventCount).toBe(30);
    expect(missions.length).toBe(6);
  });

  it("reconstructs addd0f67 — Senior Rank Medium Cargo Haul (Covalex, abandoned)", () => {
    const m = find("addd0f67");
    expect(m, "addd0f67 mission must be reconstructed").toBeTruthy();
    if (!m) return;
    expect(m.title).toContain("Senior Rank");
    expect(m.title).toContain("Medium Cargo Haul");
    expect(m.giver.toLowerCase()).toContain("covalex");
    expect(m.variant).toBe("SINGLE_TO_MULTI");
    expect(m.grade).toBe("SUPPLY");
    expect(m.status).toBe("abandoned");

    // The 4 known dropoff legs (commodity, scu, location).
    const drops = m.legs.filter((l) => l.kind === "dropoff");
    expect(drops.length).toBe(4);
    const has = (commodity: string, scu: number, loc: string): boolean =>
      drops.some(
        (l) =>
          l.commodity === commodity && l.scuTotal === scu && l.location === loc,
      );
    expect(has("Pressurized Ice", 13, "HDPC-Cassillo")).toBe(true);
    expect(has("Processed Food", 188, "Teasa Spaceport")).toBe(true);
    expect(has("Pressurized Ice", 9, "HDPC-Farnesway")).toBe(true);
    expect(has("Processed Food", 150, "HDPC-Cassillo")).toBe(true);
  });

  it("reconstructs the completed missions with correct variant + status", () => {
    const checks: Array<{
      prefix: string;
      variant: string;
      status: string;
    }> = [
      { prefix: "65af15d8", variant: "A_TO_B", status: "complete" },
      { prefix: "c53c329c", variant: "MULTI_TO_SINGLE", status: "complete" },
      { prefix: "01ab24e3", variant: "A_TO_B", status: "complete" },
    ];
    for (const c of checks) {
      const m = find(c.prefix);
      expect(m, `${c.prefix} must be reconstructed`).toBeTruthy();
      if (!m) continue;
      expect(m.variant, `${c.prefix} variant`).toBe(c.variant);
      expect(m.status, `${c.prefix} status`).toBe(c.status);
    }
  });

  it("132109f5 carries a 29 Waste -> Everus Harbor leg and is complete", () => {
    const m = find("132109f5");
    expect(m, "132109f5 must be reconstructed").toBeTruthy();
    if (!m) return;
    expect(m.status).toBe("complete");
    const leg = m.legs.find(
      (l) =>
        l.kind === "dropoff" &&
        l.commodity === "Waste" &&
        l.scuTotal === 29 &&
        l.location === "Everus Harbor",
    );
    expect(leg, "29 Waste -> Everus Harbor leg present").toBeTruthy();
  });

  it("c1989ecd is a RedWind Hydrogen haul (intermittent-suppression path: no SCU line)", () => {
    const m = find("c1989ecd");
    expect(m, "c1989ecd must be reconstructed").toBeTruthy();
    if (!m) return;
    expect(m.giver.toLowerCase()).toContain("redwind");
    // Hydrogen appears either as a leg commodity or in the contract template.
    const hasHydrogen =
      m.legs.some((l) => /hydrogen/i.test(l.commodity)) ||
      /hydrogen/i.test(m.contractTemplate ?? "");
    expect(hasHydrogen, "Hydrogen commodity/template").toBe(true);
  });

  it("attributes payouts by timestamp correlation and accrues total credits", () => {
    const totals = store.totals();
    expect(totals.creditsEarned).toBeGreaterThan(0);

    // At least one mission has a payout attributed.
    const attributed = missions.filter((m) => m.payout !== null);
    expect(attributed.length).toBeGreaterThan(0);

    // The two awards in the fixture (28375 + 35625) correlate to the missions
    // that completed just before them and accrue into the total.
    const payoutValues = new Set(missions.map((m) => m.payout));
    expect(payoutValues.has(28375)).toBe(true);
    expect(payoutValues.has(35625)).toBe(true);
    expect(totals.creditsEarned).toBe(28375 + 35625);

    // The "Fined N UEC" line is tracked separately and never reduces a payout.
    expect(totals.finesTotal).toBe(20000);
  });

  // ==========================================================================
  // The bug fix: active Mission List excludes terminal (complete/abandoned)
  // missions; History holds the terminal ones.
  // ==========================================================================
  it("active Mission List excludes terminal missions; History holds them", () => {
    const active = store.activeMissions();
    const all = store.listMissions();
    const history = store.history();

    // Every active mission is non-terminal.
    for (const m of active) {
      expect(["accepted", "in_progress"]).toContain(m.status);
    }
    // History holds only terminal hauls (completed + abandoned).
    expect(history.length).toBeGreaterThan(0);
    for (const m of history) {
      expect(["complete", "abandoned"]).toContain(m.status);
    }
    // No terminal mission leaks into the active list.
    const activeIds = new Set(active.map((m) => m.id));
    for (const m of all) {
      if (m.status === "complete" || m.status === "abandoned") {
        expect(activeIds.has(m.id)).toBe(false);
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `\n[active-vs-history] total=${all.length} active=${active.length} ` +
        `history=${history.length}`,
    );
  });

  it("clearActiveMissions empties active but preserves history; resetAllData wipes all", () => {
    // Work on a SEPARATE store so we don't disturb the shared one used above.
    const s2 = openMissionStore({ dbPath: ":memory:" });
    const text = readFileSync(FIXTURE, "utf8");
    for (const e of parseChunk(text)) s2.applyEvent(e, "live");

    const historyBefore = s2.history().length;

    // Clear active: removes live non-terminal; history untouched.
    s2.clearActiveMissions();
    expect(s2.activeMissions().length).toBe(0);
    expect(s2.history().length).toBe(historyBefore);

    // Reset all: nothing left at all.
    const removed = s2.resetAllData();
    expect(removed).toBeGreaterThanOrEqual(0);
    expect(s2.listMissions().length).toBe(0);
    expect(s2.history().length).toBe(0);
    s2.close();
  });

  // Emit a human-readable reconstruction summary to the test log (the "proof").
  it("prints the reconstruction summary", () => {
    const lines: string[] = [];
    lines.push("");
    lines.push(
      "================ FIXTURE RECONSTRUCTION SUMMARY ================",
    );
    lines.push(`events parsed:          ${eventCount}`);
    lines.push(`missions reconstructed: ${missions.length}`);

    const byStatus: Record<string, number> = {};
    let totalLegs = 0;
    for (const m of missions) {
      byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
      totalLegs += m.legs.length;
    }
    lines.push(`legs total:             ${totalLegs}`);
    lines.push(`by status:              ${JSON.stringify(byStatus)}`);

    const totals = store.totals();
    lines.push(
      `totals:                 completed=${totals.missionsCompleted} ` +
        `scuHauled=${totals.scuHauled} credits=${totals.creditsEarned} ` +
        `fines=${totals.finesTotal}`,
    );

    lines.push("");
    lines.push("--- known missions ---");
    for (const prefix of [
      "addd0f67",
      "65af15d8",
      "c53c329c",
      "132109f5",
      "01ab24e3",
      "c1989ecd",
    ]) {
      const m = missions.find((x) => x.id.startsWith(prefix));
      if (!m) {
        lines.push(`${prefix}: (not found)`);
        continue;
      }
      lines.push(
        `${prefix}: "${m.title}" | ${m.giver} | ${m.variant}/${m.grade} | ` +
          `${m.status} | payout=${m.payout ?? "—"} (${m.payoutConfidence}) | ` +
          `${m.legs.length} legs`,
      );
      for (const l of m.legs) {
        lines.push(
          `    [${l.kind}] ${l.scuTotal} ${l.commodity || "?"} -> ` +
            `${l.location ?? "?"}${l.completed ? " ✓" : ""}`,
        );
      }
    }

    // By-dropoff aggregation across active missions (currentLocation null in test).
    lines.push("");
    lines.push("--- by-dropoff (active missions) ---");
    const groups = store.dropoffGroups(null);
    if (groups.length === 0) lines.push("  (no active dropoffs)");
    for (const g of groups) {
      lines.push(
        `  ${g.location}: remaining=${g.scuRemaining}/${g.scuTotal} ` +
          `(${g.pctDelivered}%)${g.allDone ? " [done]" : ""}`,
      );
      for (const c of g.todo)
        lines.push(`      • ${c.scuRemaining} ${c.commodity}`);
    }
    lines.push(
      "================================================================",
    );

    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
    expect(true).toBe(true);
  });
});
