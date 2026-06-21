// selectors.test.ts — pure renderer derivations. Focused on the "incomplete"
// predicate that drives the ⚠ Details-missing indicator (the token-suppressed
// objectiveDeclared bug), plus the by-dropoff appearance once a leg is filled in.
import { describe, it, expect } from "vitest";
import type { Mission, Leg, LogPathInfo, LogStatus } from "@shared/types";
import {
  isLegIncomplete,
  isMissionIncomplete,
  dropoffGroups,
  shouldShowLogBanner,
  UNKNOWN_DESTINATION,
} from "./selectors";

function leg(partial: Partial<Leg>): Leg {
  return {
    id: "d0",
    missionId: "m1",
    kind: "dropoff",
    commodity: "",
    scuTotal: 0,
    scuDelivered: 0,
    location: null,
    completed: false,
    ...partial,
  };
}

function mission(legs: Leg[]): Mission {
  return {
    id: "m1",
    title: "Senior Rank - Medium Cargo Haul",
    giver: "Covalex_Hauling",
    variant: "SINGLE_TO_MULTI",
    grade: "BULK",
    status: "accepted",
    payout: null,
    payoutConfidence: "unknown",
    source: "log",
    acceptedAt: 1000,
    completedAt: null,
    notes: "",
    legs,
  };
}

describe("isLegIncomplete", () => {
  it("a dropoff with no location is incomplete", () => {
    expect(isLegIncomplete(leg({ scuTotal: 10, location: null }))).toBe(true);
  });

  it("a dropoff with scuTotal 0 is incomplete", () => {
    expect(
      isLegIncomplete(leg({ scuTotal: 0, location: "HDPC-Cassillo" })),
    ).toBe(true);
  });

  it("a fully-detailed dropoff is complete", () => {
    expect(
      isLegIncomplete(leg({ scuTotal: 10, location: "HDPC-Cassillo" })),
    ).toBe(false);
  });

  it("a blank PICKUP is not flagged (pickups don't feed by-dropoff)", () => {
    expect(
      isLegIncomplete(leg({ kind: "pickup", scuTotal: 0, location: null })),
    ).toBe(false);
  });
});

describe("isMissionIncomplete", () => {
  it("flags a mission with any token-suppressed dropoff leg", () => {
    const m = mission([
      leg({ id: "d0", commodity: "", scuTotal: 0, location: null }),
      leg({ id: "d1", commodity: "Ice", scuTotal: 10, location: "A" }),
    ]);
    expect(isMissionIncomplete(m)).toBe(true);
  });

  it("does NOT flag a fully-detailed mission", () => {
    const m = mission([
      leg({ id: "d0", commodity: "Ice", scuTotal: 10, location: "A" }),
      leg({ id: "d1", commodity: "Food", scuTotal: 20, location: "B" }),
    ]);
    expect(isMissionIncomplete(m)).toBe(false);
  });

  it("a mission whose only blank leg is a pickup is not flagged", () => {
    const m = mission([
      leg({
        id: "p0",
        kind: "pickup",
        commodity: "",
        scuTotal: 0,
        location: null,
      }),
      leg({ id: "d0", commodity: "Ice", scuTotal: 10, location: "A" }),
    ]);
    expect(isMissionIncomplete(m)).toBe(false);
  });
});

describe("filled-in leg flows into by-dropoff (renderer selector)", () => {
  it("a blank leg is absent; once filled it appears with the right remaining SCU", () => {
    const blank = mission([
      leg({ id: "d0", commodity: "", scuTotal: 0, location: null }),
    ]);
    // Blank dropoff falls under the needs-location bucket with 0 remaining.
    const before = dropoffGroups([blank], null);
    expect(before.find((g) => g.location === "HDPC-Cassillo")).toBeUndefined();
    expect(
      before.find((g) => g.location === UNKNOWN_DESTINATION),
    ).toBeDefined();

    const filled = mission([
      leg({
        id: "d0",
        commodity: "Pressurized Ice",
        scuTotal: 42,
        location: "HDPC-Cassillo",
      }),
    ]);
    const after = dropoffGroups([filled], null);
    const g = after.find((x) => x.location === "HDPC-Cassillo")!;
    expect(g).toBeDefined();
    const ice = g.todo.find((c) => c.commodity === "Pressurized Ice")!;
    expect(ice.scuRemaining).toBe(42);
    expect(g.allDone).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The synthetic "needs a destination" bucket: dropoff legs with null location
// land here, the group is flagged `needsLocation`, it floats to the top of the
// list (most actionable), and its commodity line carries the legRefs so the UI
// can resolve each leg for inline editing. Normal grouping is unchanged.
// ---------------------------------------------------------------------------
describe("needs-location group (UNKNOWN_DESTINATION / needsLocation)", () => {
  it("a null-location dropoff lands in the needsLocation group with that flag set", () => {
    const m = mission([
      leg({ id: "d0", commodity: "Titanium", scuTotal: 0, location: null }),
    ]);
    const groups = dropoffGroups([m], null);
    const g = groups.find((x) => x.location === UNKNOWN_DESTINATION)!;
    expect(g).toBeDefined();
    expect(g.needsLocation).toBe(true);
    // The leg is preserved as a ref so the UI can resolve + edit it inline.
    const line = g.todo.find((c) => c.commodity === "Titanium")!;
    expect(line).toBeDefined();
    expect(line.legRefs).toEqual([{ missionId: "m1", legId: "d0" }]);
  });

  it("a known-location group is NOT flagged needsLocation", () => {
    const m = mission([
      leg({ id: "d0", commodity: "Ice", scuTotal: 10, location: "A" }),
    ]);
    const groups = dropoffGroups([m], null);
    const g = groups.find((x) => x.location === "A")!;
    expect(g).toBeDefined();
    expect(g.needsLocation).toBe(false);
  });

  it("the needs-location group floats above normal active stops", () => {
    const m = mission([
      // A real stop with lots of remaining SCU…
      leg({ id: "d0", commodity: "Ice", scuTotal: 500, location: "A" }),
      // …and a suppressed leg with 0 remaining that must still surface first.
      leg({ id: "d1", commodity: "Gold", scuTotal: 0, location: null }),
    ]);
    const groups = dropoffGroups([m], null);
    expect(groups[0].location).toBe(UNKNOWN_DESTINATION);
    expect(groups[0].needsLocation).toBe(true);
  });

  it("aggregates null-location legs across missions into one bucket with all refs", () => {
    const a = {
      ...mission([
        leg({
          id: "x",
          missionId: "mA",
          commodity: "Ore",
          scuTotal: 0,
          location: null,
        }),
      ]),
      id: "mA",
    };
    const b = {
      ...mission([
        leg({
          id: "y",
          missionId: "mB",
          commodity: "Ore",
          scuTotal: 0,
          location: null,
        }),
      ]),
      id: "mB",
    };
    const groups = dropoffGroups([a, b], null);
    const g = groups.find((x) => x.location === UNKNOWN_DESTINATION)!;
    const line = g.todo.find((c) => c.commodity === "Ore")!;
    expect(line.legRefs).toEqual([
      { missionId: "mA", legId: "x" },
      { missionId: "mB", legId: "y" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// shouldShowLogBanner — the show/hide predicate for the log-not-found warning
// strip. Found -> hidden; missing -> shown; transient boot/searching -> hidden.
// ---------------------------------------------------------------------------
describe("shouldShowLogBanner", () => {
  const pathInfo = (over: Partial<LogPathInfo>): LogPathInfo => ({
    liveFolder: null,
    gameLogPath: "C:/StarCitizen/LIVE/Game.log",
    isDefault: true,
    gameLogExists: true,
    ...over,
  });
  const status = (over: Partial<LogStatus>): LogStatus => ({
    state: "connected",
    logPath: "C:/StarCitizen/LIVE/Game.log",
    uexActive: true,
    ...over,
  });

  it("hidden when Game.log is found (connected)", () => {
    expect(
      shouldShowLogBanner(pathInfo({ gameLogExists: true }), status({})),
    ).toBe(false);
  });

  it("shown when Game.log does not exist on disk", () => {
    expect(
      shouldShowLogBanner(
        pathInfo({ gameLogExists: false }),
        status({ state: "searching" }),
      ),
    ).toBe(true);
  });

  it("shown when the file exists but the watcher is hard-disconnected", () => {
    expect(
      shouldShowLogBanner(
        pathInfo({ gameLogExists: true }),
        status({ state: "disconnected" }),
      ),
    ).toBe(true);
  });

  it("hidden while still resolving (no path info yet)", () => {
    expect(shouldShowLogBanner(null, status({ state: "searching" }))).toBe(
      false,
    );
  });

  it("hidden during transient searching state when the file does exist", () => {
    expect(
      shouldShowLogBanner(
        pathInfo({ gameLogExists: true }),
        status({ state: "searching" }),
      ),
    ).toBe(false);
  });

  it("tolerates a null log status (found -> hidden, missing -> shown)", () => {
    expect(shouldShowLogBanner(pathInfo({ gameLogExists: true }), null)).toBe(
      false,
    );
    expect(shouldShowLogBanner(pathInfo({ gameLogExists: false }), null)).toBe(
      true,
    );
  });
});
