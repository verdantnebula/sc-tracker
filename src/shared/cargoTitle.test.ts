// ============================================================================
// cargoTitle.test.ts — the Auto OCR Capture cargo-title filter (Phase 3).
// ----------------------------------------------------------------------------
// Auto-capture only fires for cargo hauls; this gate must be permissive on real
// haul titles, case-insensitive, and reject non-cargo / unclassifiable titles.
// ============================================================================

import { describe, it, expect } from "vitest";
import { isCargoHaulTitle } from "./cargoTitle";

describe("isCargoHaulTitle", () => {
  it("matches typical cargo-haul titles (case-insensitive)", () => {
    expect(isCargoHaulTitle("Senior Rank - Medium Cargo Haul")).toBe(true);
    expect(isCargoHaulTitle("Bulk Cargo Run")).toBe(true);
    expect(isCargoHaulTitle("Hauling Contract")).toBe(true);
    expect(isCargoHaulTitle("HAUL")).toBe(true);
    expect(isCargoHaulTitle("cargo")).toBe(true);
    // Mixed/odd casing still matches the keyword substring.
    expect(isCargoHaulTitle("CaRgO hAuL")).toBe(true);
  });

  it("matches the keyword anywhere in the title (substring)", () => {
    expect(isCargoHaulTitle("Local Delivery | Cargo")).toBe(true);
    expect(isCargoHaulTitle("Overhauling the depot")).toBe(true); // contains "haul"
  });

  it("rejects non-cargo contract titles", () => {
    expect(isCargoHaulTitle("Eliminate the bounty target")).toBe(false);
    expect(isCargoHaulTitle("Mining Survey")).toBe(false);
    expect(isCargoHaulTitle("Investigate the wreck")).toBe(false);
    expect(isCargoHaulTitle("Package Delivery")).toBe(false);
  });

  it("is defensive: non-string / empty -> false", () => {
    expect(isCargoHaulTitle("")).toBe(false);
    expect(isCargoHaulTitle(null)).toBe(false);
    expect(isCargoHaulTitle(undefined)).toBe(false);
    expect(isCargoHaulTitle(42)).toBe(false);
    expect(isCargoHaulTitle({})).toBe(false);
  });
});
