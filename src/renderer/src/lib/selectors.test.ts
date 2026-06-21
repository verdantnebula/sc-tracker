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
    // Blank dropoff falls under the "Unknown destination" bucket with 0 remaining.
    const before = dropoffGroups([blank], null);
    expect(before.find((g) => g.location === "HDPC-Cassillo")).toBeUndefined();

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
