// ============================================================================
// miningArea.test.ts — unit tests for location-aware mining area resolution.
// Pure helpers: resolveBody, areaRegionsForBody, depositInArea. No DOM.
// ============================================================================

import { describe, it, expect } from "vitest";
import type { MiningDeposit } from "./types";
import { resolveBody, areaRegionsForBody, depositInArea } from "./miningArea";

describe("resolveBody", () => {
  it("resolves Hurston by city / station / outpost ids", () => {
    expect(resolveBody("Lorville")).toBe("Hurston");
    expect(resolveBody("Everus Harbor")).toBe("Hurston");
    expect(resolveBody("HUR-L3 Thundering Express Station")).toBe("Hurston");
    expect(resolveBody("HDMS-Edmond")).toBe("Hurston");
    expect(resolveBody("HDPC-Cassillo")).toBe("Hurston");
    expect(resolveBody("Teasa Spaceport")).toBe("Hurston");
  });

  it("resolves microTech", () => {
    expect(resolveBody("New Babbage")).toBe("microTech");
    expect(resolveBody("Port Tressler")).toBe("microTech");
    expect(resolveBody("MIC-L1 Shallow Frontier Station")).toBe("microTech");
    expect(resolveBody("Rayari Anvik Research Outpost")).toBe("microTech");
  });

  it("resolves ArcCorp", () => {
    expect(resolveBody("Area 18")).toBe("ArcCorp");
    expect(resolveBody("Baijini Point")).toBe("ArcCorp");
    expect(resolveBody("ARC-L1 Wide Forest Station")).toBe("ArcCorp");
    expect(resolveBody("ArcCorp Mining Area 045")).toBe("ArcCorp");
  });

  it("resolves Crusader", () => {
    expect(resolveBody("Orison")).toBe("Crusader");
    expect(resolveBody("Seraphim Station")).toBe("Crusader");
    expect(resolveBody("CRU-L1 Ambitious Dream Station")).toBe("Crusader");
    expect(resolveBody("Port Olisar")).toBe("Crusader");
  });

  it("resolves Pyro stations (Pyro wins over generic substrings)", () => {
    expect(resolveBody("Ruin Station")).toBe("Pyro");
    expect(resolveBody("Checkmate Station")).toBe("Pyro");
    expect(resolveBody("PYAM-FARSTAT-1-2")).toBe("Pyro");
    expect(resolveBody("Pyro Gateway (Stanton)")).toBe("Pyro");
    expect(resolveBody("Starlight Service Station")).toBe("Pyro");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(resolveBody("  everus harbor  ")).toBe("Hurston");
    expect(resolveBody("NEW BABBAGE")).toBe("microTech");
  });

  it("returns null for empty / unmappable / nullish input", () => {
    expect(resolveBody(null)).toBeNull();
    expect(resolveBody(undefined)).toBeNull();
    expect(resolveBody("")).toBeNull();
    expect(resolveBody("   ")).toBeNull();
    expect(resolveBody("Some Unknown Place")).toBeNull();
  });
});

describe("areaRegionsForBody", () => {
  it("includes the body + its moons for Hurston", () => {
    const r = areaRegionsForBody("Hurston");
    expect(r).toContain("Hurston");
    expect(r).toContain("Aberdeen");
    expect(r).toContain("Arial");
    expect(r).toContain("Magda");
    expect(r).toContain("Ita");
  });

  it("adds the Stanton-wide regions for a Stanton body", () => {
    const r = areaRegionsForBody("microTech");
    expect(r).toContain("Calliope");
    expect(r).toContain("Aaron Halo");
    expect(r).toContain("Stanton Lagrange Points");
    expect(r).toContain("Found in All Deposits");
    expect(r).toContain("MIC-L");
  });

  it("Crusader includes its moons + Stanton-wide", () => {
    const r = areaRegionsForBody("Crusader");
    expect(r).toEqual(
      expect.arrayContaining(["Cellin", "Yela", "Daymar", "Aaron Halo"]),
    );
  });

  it("ArcCorp includes its moons", () => {
    const r = areaRegionsForBody("ArcCorp");
    expect(r).toEqual(expect.arrayContaining(["Lyria", "Wala", "ArcCorp"]));
  });

  it("Pyro gets the Pyro-wide set, NOT the Stanton set", () => {
    const r = areaRegionsForBody("Pyro");
    expect(r).toContain("Pyro");
    expect(r).toContain("Found in All Pyro Deposits");
    expect(r).toContain("Bloom");
    expect(r).not.toContain("Aaron Halo");
    expect(r).not.toContain("Found in All Deposits");
  });

  it("returns [] for a null body", () => {
    expect(areaRegionsForBody(null)).toEqual([]);
  });

  it("de-duplicates", () => {
    const r = areaRegionsForBody("Hurston");
    expect(new Set(r).size).toBe(r.length);
  });
});

describe("depositInArea", () => {
  const dep = (foundAt: string[]): MiningDeposit => ({
    name: "X",
    type: "Ship Mineable",
    foundAt,
  });

  it("matches a deposit on a moon of the resolved body", () => {
    const regions = areaRegionsForBody("Hurston");
    expect(depositInArea(dep(["Aberdeen"]), regions)).toBe(true);
    expect(depositInArea(dep(["Magda Sand Caves"]), regions)).toBe(true); // contains "Magda"
  });

  it("matches a Lagrange-point deposit via prefix region (HUR-L matches HUR-L3)", () => {
    const regions = areaRegionsForBody("Hurston");
    expect(depositInArea(dep(["HUR-L3"]), regions)).toBe(true);
  });

  it("matches a system-wide deposit phrase", () => {
    const regions = areaRegionsForBody("ArcCorp");
    expect(depositInArea(dep(["Found in All Deposits"]), regions)).toBe(true);
    // FoundAt is more specific than the region -> region-contains-found direction.
    expect(depositInArea(dep(["Found in All Deposits (Rare)"]), regions)).toBe(
      true,
    );
  });

  it("matches Aaron Halo for any Stanton body", () => {
    expect(
      depositInArea(dep(["Aaron Halo"]), areaRegionsForBody("Crusader")),
    ).toBe(true);
  });

  it("does NOT match a deposit on a different body", () => {
    const regions = areaRegionsForBody("Hurston");
    expect(depositInArea(dep(["Calliope"]), regions)).toBe(false); // microTech moon
    expect(depositInArea(dep(["Wala"]), regions)).toBe(false); // ArcCorp moon
  });

  it("does NOT match Pyro deposits for a Stanton body", () => {
    const regions = areaRegionsForBody("microTech");
    expect(
      depositInArea(dep(["Found in All Pyro Deposits (Rare)"]), regions),
    ).toBe(false);
    expect(depositInArea(dep(["Bloom (Pyro III)"]), regions)).toBe(false);
  });

  it("matches Pyro deposits for the Pyro body", () => {
    const regions = areaRegionsForBody("Pyro");
    expect(
      depositInArea(dep(["Found in All Pyro Deposits (Rare)"]), regions),
    ).toBe(true);
    expect(depositInArea(dep(["Monox (Pyro II)"]), regions)).toBe(true);
  });

  it("returns false when the region set is empty (no body resolved)", () => {
    expect(depositInArea(dep(["Aberdeen"]), [])).toBe(false);
  });

  it("returns false for a deposit with no FoundAt entries", () => {
    expect(depositInArea(dep([]), areaRegionsForBody("Hurston"))).toBe(false);
  });
});
