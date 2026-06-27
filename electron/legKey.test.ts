// ============================================================================
// legKey.test.ts — the SCU-excluded leg convergence key
// ----------------------------------------------------------------------------
// legKey(kind, commodity, location) = kind | lower(trim(commodity)) | lower(trim(location)).
// SCU is deliberately excluded so a quantity/OCR-number difference never splits
// one logical leg. PURE + total: null/undefined collapse to "". These props
// underpin both the OCR-apply location-aware match order and the game
// New-Objective adoption (re-key synthetic -> real id).
// ============================================================================

import { describe, it, expect } from "vitest";
import { legKey } from "./missionStore";

describe("legKey — normalized leg convergence key", () => {
  it("builds kind | lower(commodity) | lower(location)", () => {
    expect(legKey("dropoff", "Quartz", "Baijini Point")).toBe(
      "dropoff|quartz|baijini point",
    );
  });

  it("is case-insensitive on commodity and location", () => {
    expect(legKey("dropoff", "QUARTZ", "BAIJINI POINT")).toBe(
      legKey("dropoff", "quartz", "baijini point"),
    );
  });

  it("trims surrounding whitespace on commodity and location", () => {
    expect(legKey("pickup", "  Iron  ", "  Lorville  ")).toBe(
      legKey("pickup", "Iron", "Lorville"),
    );
  });

  it("EXCLUDES scu: two legs differing only in quantity share a key", () => {
    // The whole point — the key carries no SCU, so an OCR/quantity disagreement
    // cannot split one logical leg.
    expect(legKey("dropoff", "Quartz", "Baijini Point")).toBe(
      legKey("dropoff", "Quartz", "Baijini Point"),
    );
  });

  it("distinguishes kind (pickup vs dropoff of same commodity+location)", () => {
    expect(legKey("pickup", "Iron", "Lorville")).not.toBe(
      legKey("dropoff", "Iron", "Lorville"),
    );
  });

  it("distinguishes different commodities and different locations", () => {
    expect(legKey("dropoff", "Iron", "Area18")).not.toBe(
      legKey("dropoff", "Gold", "Area18"),
    );
    expect(legKey("dropoff", "Iron", "Area18")).not.toBe(
      legKey("dropoff", "Iron", "Lorville"),
    );
  });

  it("collapses null/undefined commodity and location to empty (total)", () => {
    expect(legKey("dropoff", null, null)).toBe("dropoff||");
    expect(legKey("dropoff", undefined, undefined)).toBe("dropoff||");
    // Two not-yet-detailed legs of the same kind key-match.
    expect(legKey("dropoff", null, undefined)).toBe(legKey("dropoff", "", ""));
  });
});
