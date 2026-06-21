// ============================================================================
// currentLocation.test.ts — FIX 1: current location is derived ONLY from LIVE
// terminal/inventory observations, humanized sensibly, and resets on Clear/Reset.
// Pure module (no Electron/IO).
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  CurrentLocationTracker,
  humanizeLocationId,
  isConfidentLocationMatch,
} from "./currentLocation";

describe("humanizeLocationId", () => {
  it("strips a leading Stanton<n>_ system prefix and title-cases", () => {
    expect(humanizeLocationId("Stanton1_Lorville")).toBe("Lorville");
  });

  it("collapses DistributionCentre terminals to the <P>DPC-Name form", () => {
    expect(
      humanizeLocationId("Stanton1_DistributionCentre_Hurston_Farnesway"),
    ).toBe("HDPC-Farnesway");
  });

  it("keeps short all-caps station codes as hyphen-joined", () => {
    expect(humanizeLocationId("RR_HUR_LEO")).toBe("RR-HUR-LEO");
  });

  it("is defensive: empty / unrecognized passes through without throwing", () => {
    expect(humanizeLocationId("")).toBe("");
    expect(humanizeLocationId("SomethingWeird")).toBe("Somethingweird");
  });
});

describe("CurrentLocationTracker — live-vs-historical", () => {
  it("IGNORES historical observations entirely (the stale-location bug)", () => {
    const t = new CurrentLocationTracker();
    const changed = t.apply("Stanton1_Lorville", "historical");
    expect(changed).toBe(false);
    // No live observation yet -> null -> UI shows "—", never a stale value.
    expect(t.get()).toBeNull();
  });

  it("tracks the LATEST live observation as last known location", () => {
    const t = new CurrentLocationTracker();
    expect(t.apply("Stanton1_Lorville", "live")).toBe(true);
    expect(t.get()).toBe("Lorville");
    // A newer live terminal visit wins.
    expect(
      t.apply("Stanton1_DistributionCentre_Hurston_Farnesway", "live"),
    ).toBe(true);
    expect(t.get()).toBe("HDPC-Farnesway");
  });

  it("a historical observation after a live one does NOT overwrite it", () => {
    const t = new CurrentLocationTracker();
    t.apply("Stanton1_Lorville", "live");
    const changed = t.apply("Stanton1_OldStaleStation", "historical");
    expect(changed).toBe(false);
    expect(t.get()).toBe("Lorville");
  });

  it("returns false (no broadcast) when the live location is unchanged", () => {
    const t = new CurrentLocationTracker();
    expect(t.apply("Stanton1_Lorville", "live")).toBe(true);
    expect(t.apply("Stanton1_Lorville", "live")).toBe(false);
  });

  it("reset() forgets the current location (Clear / Reset)", () => {
    const t = new CurrentLocationTracker();
    t.apply("Stanton1_Lorville", "live");
    expect(t.get()).toBe("Lorville");
    t.reset();
    expect(t.get()).toBeNull();
  });

  it("ignores blank location ids", () => {
    const t = new CurrentLocationTracker();
    expect(t.apply("", "live")).toBe(false);
    expect(t.apply("   ", "live")).toBe(false);
    expect(t.get()).toBeNull();
  });
});

describe("isConfidentLocationMatch — YOU ARE HERE highlight", () => {
  it("matches case-insensitively exact", () => {
    expect(isConfidentLocationMatch("Lorville", "lorville")).toBe(true);
  });

  it("matches a strong substring (>=4 chars)", () => {
    expect(isConfidentLocationMatch("HDPC-Farnesway", "Farnesway")).toBe(true);
    expect(isConfidentLocationMatch("Cassillo", "HDPC-Cassillo")).toBe(true);
  });

  it("does NOT match on a tiny fragment (<4 chars) — no false positive", () => {
    expect(isConfidentLocationMatch("RR", "RR-HUR-LEO Terminal")).toBe(false);
  });

  it("does NOT match unrelated names (the common terminal-id case)", () => {
    expect(isConfidentLocationMatch("HDPC-Farnesway", "Port Olisar")).toBe(
      false,
    );
  });

  it("is false when either side is null/empty", () => {
    expect(isConfidentLocationMatch(null, "Lorville")).toBe(false);
    expect(isConfidentLocationMatch("Lorville", null)).toBe(false);
    expect(isConfidentLocationMatch("", "")).toBe(false);
  });
});
