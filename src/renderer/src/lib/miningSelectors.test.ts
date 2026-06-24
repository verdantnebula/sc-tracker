// ============================================================================
// miningSelectors.test.ts — unit tests for the Mining mode pure helpers.
// Focus: lookupScan (the SCAN LOOKUP centerpiece) + rarity ordering + deposit
// cross-linking. All pure, no DOM.
// ============================================================================

import { describe, it, expect } from "vitest";
import type { MiningRock, MiningDeposit } from "@shared/types";
import {
  lookupScan,
  depositForRock,
  rarityRank,
  rarityColor,
  searchRocksByName,
  areaScannableRocks,
} from "./miningSelectors";
import { areaRegionsForBody } from "@shared/miningArea";

// A small, deterministic rock set mirroring the real data shape. Ice/Aluminum
// are near each other (common); Quantainium is far away (legendary).
const ROCKS: MiningRock[] = [
  {
    name: "Ice",
    rarity: "Common",
    scanValues: [4300, 8600, 12900, 17200, 21500, 25800],
  },
  {
    name: "Aluminum",
    rarity: "Common",
    scanValues: [4285, 8570, 12855, 17140, 21425, 25710],
  },
  {
    name: "Quantainium",
    rarity: "Legendary",
    scanValues: [3170, 6340, 9510, 12680, 15850, 19020],
  },
];

describe("lookupScan", () => {
  it("finds an exact match and reports the correct tier (1-based)", () => {
    const m = lookupScan(8600, ROCKS, 0);
    expect(m).toHaveLength(1);
    expect(m[0].name).toBe("Ice");
    expect(m[0].tier).toBe(2); // 8600 is Ice's 2nd scan value
    expect(m[0].tierValue).toBe(8600);
    expect(m[0].delta).toBe(0);
  });

  it("matches tier 1 (smallest) and tier 6 (largest) by index", () => {
    expect(lookupScan(4300, ROCKS, 0)[0].tier).toBe(1);
    expect(lookupScan(25800, ROCKS, 0)[0].tier).toBe(6);
  });

  it("returns [] when no rock matches (no-match case)", () => {
    expect(lookupScan(123, ROCKS, 0)).toEqual([]);
    expect(lookupScan(99999, ROCKS, 1)).toEqual([]);
  });

  it("absorbs radar rounding within the tolerance percentage", () => {
    // 8590 is 10 off Ice's tier-2 (8600) -> 0.116%, inside ±1%.
    const m = lookupScan(8590, ROCKS, 1);
    expect(m.some((x) => x.name === "Ice" && x.tier === 2)).toBe(true);
  });

  it("does NOT match outside the tolerance percentage", () => {
    // 8000 is ~7% off Ice's tier-2 (8600) -> outside ±1%.
    const m = lookupScan(8000, ROCKS, 1);
    expect(m.some((x) => x.name === "Ice")).toBe(false);
  });

  it("returns MULTIPLE matches when several rock tiers fall in tolerance", () => {
    // 8585 sits between Aluminum t2 (8570, Δ15) and Ice t2 (8600, Δ15) — both
    // within ±1%. Expect both, closest-delta first (tie -> rarer, then name).
    const m = lookupScan(8585, ROCKS, 1);
    const names = m.map((x) => x.name);
    expect(names).toContain("Ice");
    expect(names).toContain("Aluminum");
    // Results are delta-sorted ascending.
    for (let i = 1; i < m.length; i++) {
      expect(m[i].delta).toBeGreaterThanOrEqual(m[i - 1].delta);
    }
  });

  it("defaults to a ±1% tolerance when none is passed", () => {
    // 8540 is ~0.7% off Ice t2 -> inside the default ±1%.
    expect(lookupScan(8540, ROCKS).some((x) => x.name === "Ice")).toBe(true);
  });

  it("ignores non-finite queries", () => {
    expect(lookupScan(NaN, ROCKS)).toEqual([]);
    expect(lookupScan(Infinity, ROCKS)).toEqual([]);
  });

  it("matches a far-apart legendary rock cleanly", () => {
    const m = lookupScan(19020, ROCKS, 0);
    expect(m).toHaveLength(1);
    expect(m[0].name).toBe("Quantainium");
    expect(m[0].rarity).toBe("Legendary");
    expect(m[0].tier).toBe(6);
  });
});

describe("rarityRank / rarityColor", () => {
  it("ranks the rarity ladder ascending (common lowest)", () => {
    expect(rarityRank("Common")).toBeLessThan(rarityRank("Uncommon"));
    expect(rarityRank("Uncommon")).toBeLessThan(rarityRank("Rare"));
    expect(rarityRank("Rare")).toBeLessThan(rarityRank("Epic"));
    expect(rarityRank("Epic")).toBeLessThan(rarityRank("Legendary"));
  });

  it("sorts unknown rarities last", () => {
    expect(rarityRank("Mythic")).toBeGreaterThan(rarityRank("Legendary"));
  });

  it("maps each rarity to a distinct theme token", () => {
    const tokens = new Set(
      ["Common", "Uncommon", "Rare", "Epic", "Legendary"].map(rarityColor),
    );
    expect(tokens.size).toBe(5);
    expect(rarityColor("Common")).toBe("var(--rarity-common)");
    expect(rarityColor("Legendary")).toBe("var(--rarity-legendary)");
  });

  it("falls back to muted for an unknown rarity", () => {
    expect(rarityColor("???")).toBe("var(--muted)");
  });
});

describe("depositForRock", () => {
  const DEPOSITS: MiningDeposit[] = [
    { name: "Ice", type: "Ship Mineable", foundAt: ["microTech", "Calliope"] },
    {
      name: "Gold",
      type: "Ship Mineable (Rare)",
      foundAt: ["Found in All Deposits (Rare)"],
    },
  ];

  it("cross-links a rock to its deposit by name", () => {
    const d = depositForRock("Ice", DEPOSITS);
    expect(d?.foundAt).toContain("microTech");
  });

  it("returns null when no deposit matches", () => {
    expect(depositForRock("Stileron", DEPOSITS)).toBeNull();
  });

  it("links normalized Gold (rocks 'Gold 1' -> 'Gold') to its deposit", () => {
    // The converter normalizes 'Gold 1' to 'Gold', so the scan match name is
    // 'Gold', which must resolve to the 'Gold' deposit row.
    expect(depositForRock("Gold", DEPOSITS)?.type).toBe("Ship Mineable (Rare)");
  });
});

describe("searchRocksByName", () => {
  it("returns all rocks for an empty query (rarity-desc then name)", () => {
    const r = searchRocksByName("", ROCKS);
    expect(r).toHaveLength(ROCKS.length);
    // Legendary (Quantainium) sorts before the commons.
    expect(r[0].name).toBe("Quantainium");
  });

  it("filters by case-insensitive substring", () => {
    expect(searchRocksByName("ice", ROCKS).map((r) => r.name)).toEqual(["Ice"]);
    expect(searchRocksByName("ALU", ROCKS).map((r) => r.name)).toEqual([
      "Aluminum",
    ]);
  });

  it("ranks prefix matches ahead of mere contains matches", () => {
    const rocks: MiningRock[] = [
      { name: "Beryl", rarity: "Common", scanValues: [1, 2, 3, 4, 5, 6] },
      { name: "Aberyl", rarity: "Common", scanValues: [1, 2, 3, 4, 5, 6] },
    ];
    // Query "ber": "Beryl" starts-with, "Aberyl" only contains -> Beryl first.
    expect(searchRocksByName("ber", rocks).map((r) => r.name)).toEqual([
      "Beryl",
      "Aberyl",
    ]);
  });

  it("returns [] when nothing matches", () => {
    expect(searchRocksByName("zzz", ROCKS)).toEqual([]);
  });

  it("trims whitespace around the query", () => {
    expect(searchRocksByName("  ice  ", ROCKS).map((r) => r.name)).toEqual([
      "Ice",
    ]);
  });
});

// ---------------------------------------------------------------------------
// areaScannableRocks — the Mining overlay's "minerals near you" set. Reuses
// depositForRock + depositInArea (via @shared/miningArea regions), so these
// tests pin the integration: only rocks whose deposit is in-area come back,
// rarest-first, and an empty region set yields nothing.
// ---------------------------------------------------------------------------

describe("areaScannableRocks", () => {
  // Scan rocks: Ice (common, Hurston moon), Gold (rare, system-wide belt),
  // Quantainium (legendary, Hurston moon), Diamond (epic, microTech only — out
  // of area for Hurston), Stileron (uncommon, no deposit row — never near).
  const ROCKS_A: MiningRock[] = [
    { name: "Ice", rarity: "Common", scanValues: [1, 2, 3, 4, 5, 6] },
    { name: "Gold", rarity: "Rare", scanValues: [1, 2, 3, 4, 5, 6] },
    {
      name: "Quantainium",
      rarity: "Legendary",
      scanValues: [1, 2, 3, 4, 5, 6],
    },
    { name: "Diamond", rarity: "Epic", scanValues: [1, 2, 3, 4, 5, 6] },
    { name: "Stileron", rarity: "Uncommon", scanValues: [1, 2, 3, 4, 5, 6] },
  ];
  const DEPS_A: MiningDeposit[] = [
    { name: "Ice", type: "Ship Mineable", foundAt: ["Aberdeen"] }, // Hurston moon
    { name: "Gold", type: "Ship Mineable", foundAt: ["Aaron Halo"] }, // Stanton belt
    { name: "Quantainium", type: "Ship Mineable", foundAt: ["Magda"] }, // Hurston moon
    { name: "Diamond", type: "Ship Mineable", foundAt: ["Calliope"] }, // microTech moon
    // Stileron has NO deposit row -> not locatable -> never near.
  ];

  it("returns only rocks whose deposit is minable in the area", () => {
    const regions = areaRegionsForBody("Hurston");
    const names = areaScannableRocks(ROCKS_A, DEPS_A, regions).map(
      (a) => a.rock.name,
    );
    // Ice + Quantainium (Hurston moons) + Gold (Aaron Halo, Stanton-wide). NOT
    // Diamond (microTech moon) and NOT Stileron (no deposit).
    expect(names).toContain("Ice");
    expect(names).toContain("Gold");
    expect(names).toContain("Quantainium");
    expect(names).not.toContain("Diamond");
    expect(names).not.toContain("Stileron");
  });

  it("sorts rarest-first then by name", () => {
    const regions = areaRegionsForBody("Hurston");
    const names = areaScannableRocks(ROCKS_A, DEPS_A, regions).map(
      (a) => a.rock.name,
    );
    // Legendary > Rare > Common -> Quantainium, Gold, Ice.
    expect(names).toEqual(["Quantainium", "Gold", "Ice"]);
  });

  it("pairs each rock with its matched deposit", () => {
    const regions = areaRegionsForBody("Hurston");
    const ice = areaScannableRocks(ROCKS_A, DEPS_A, regions).find(
      (a) => a.rock.name === "Ice",
    );
    expect(ice?.deposit.foundAt).toEqual(["Aberdeen"]);
  });

  it("returns [] when no body resolved (empty region set)", () => {
    expect(areaScannableRocks(ROCKS_A, DEPS_A, [])).toEqual([]);
  });

  it("includes microTech rocks only for the microTech area", () => {
    const names = areaScannableRocks(
      ROCKS_A,
      DEPS_A,
      areaRegionsForBody("microTech"),
    ).map((a) => a.rock.name);
    // Diamond (Calliope) + Gold (Aaron Halo, Stanton-wide). NOT the Hurston-only.
    expect(names).toContain("Diamond");
    expect(names).toContain("Gold");
    expect(names).not.toContain("Ice");
    expect(names).not.toContain("Quantainium");
  });
});
