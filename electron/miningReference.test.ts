// ============================================================================
// miningReference.test.ts — validates the CSV -> JSON converter and the bundled
// mining-reference.json snapshot it produces.
// ----------------------------------------------------------------------------
// Imports the PURE helpers from scripts/fetch-mining-reference.mjs and runs them
// over the REAL committed source CSVs (electron/data/sources/*.csv), then asserts
// the shape contract: 26 rocks, 61 deposits, Gold normalization, scan-value
// arrays, FoundAt parsing (lists + single phrases), and preserved game quirks.
// Also sanity-checks the loader (createMiningReference) over the bundled JSON.
// ============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// The converter is a dev script (.mjs); its parse helpers are exported pure.
import {
  parseCsv,
  parseRocks,
  parseDeposits,
  buildSnapshot,
} from "../scripts/fetch-mining-reference.mjs";
import { createMiningReference } from "./miningReference";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const SRC = join(ROOT, "electron", "data", "sources");
const rocksCsv = readFileSync(join(SRC, "rock_values.csv"), "utf-8");
const locationsCsv = readFileSync(join(SRC, "mineable_locations.csv"), "utf-8");

describe("parseCsv", () => {
  it("splits simple rows", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("keeps commas inside quoted fields", () => {
    const rows = parseCsv('Name,FoundAt\nIron,"Aaron Halo, Yela, Cellin"');
    expect(rows[1]).toEqual(["Iron", "Aaron Halo, Yela, Cellin"]);
  });

  it("drops fully-blank trailing rows", () => {
    expect(parseCsv("a,b\n1,2\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("parseRocks", () => {
  const rocks = parseRocks(rocksCsv);

  it("parses exactly 26 rocks", () => {
    expect(rocks).toHaveLength(26);
  });

  it("gives every rock 6 numeric scan values", () => {
    for (const r of rocks) {
      expect(r.scanValues).toHaveLength(6);
      for (const v of r.scanValues) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("normalizes 'Gold 1' -> 'Gold' and drops the 'Gold 1' spelling", () => {
    expect(rocks.some((r) => r.name === "Gold 1")).toBe(false);
    const gold = rocks.find((r) => r.name === "Gold");
    expect(gold).toBeTruthy();
    expect(gold?.rarity).toBe("Rare");
    expect(gold?.scanValues[0]).toBe(3585);
  });

  it("reads scan values as the base x 1..6 ladder (Ice)", () => {
    const ice = rocks.find((r) => r.name === "Ice");
    expect(ice?.scanValues).toEqual([4300, 8600, 12900, 17200, 21500, 25800]);
  });

  it("carries the five rarity tiers from the source", () => {
    const rarities = new Set(rocks.map((r) => r.rarity));
    expect(rarities).toEqual(
      new Set(["Common", "Uncommon", "Rare", "Epic", "Legendary"]),
    );
  });
});

describe("parseDeposits", () => {
  const deposits = parseDeposits(locationsCsv);

  it("parses exactly 61 deposits", () => {
    expect(deposits).toHaveLength(61);
  });

  it("splits a comma list FoundAt into a trimmed string array", () => {
    const quartz = deposits.find((d) => d.name === "Quartz");
    expect(Array.isArray(quartz?.foundAt)).toBe(true);
    expect(quartz?.foundAt.length).toBeGreaterThan(3);
    expect(quartz?.foundAt).toContain("Aaron Halo");
    // No leading/trailing whitespace survived the split.
    for (const loc of quartz!.foundAt) expect(loc).toBe(loc.trim());
  });

  it("keeps a single descriptive phrase as one element", () => {
    const agricium = deposits.find((d) => d.name === "Agricium");
    expect(agricium?.foundAt).toEqual(["Found in All Deposits"]);
    const aphorite = deposits.find((d) => d.name === "Aphorite");
    expect(aphorite?.foundAt).toEqual(["All Moons/Planets/Caves"]);
  });

  it("preserves the three Aluminum spellings as distinct rows", () => {
    const names = deposits.map((d) => d.name);
    expect(names).toContain("Aluminium");
    expect(names).toContain("Aluminum");
    expect(names).toContain("Alumium"); // CIG typo, kept verbatim
  });

  it("preserves the 'Janalite (Caves only)' quirk as its own row", () => {
    expect(deposits.some((d) => d.name === "Janalite (Caves only)")).toBe(true);
    expect(deposits.some((d) => d.name === "Janalite")).toBe(true);
  });

  it("keeps rarity-qualified type variants verbatim", () => {
    const riccite = deposits.find((d) => d.name === "Riccite");
    expect(riccite?.type).toBe("Ship Mineable (Rare, Pyro Only)");
  });
});

describe("buildSnapshot", () => {
  const snap = buildSnapshot(rocksCsv, locationsCsv);

  it("emits the documented shape", () => {
    expect(snap).toHaveProperty("rocks");
    expect(snap).toHaveProperty("deposits");
    expect(snap).toHaveProperty("fetchedAt");
    expect(snap).toHaveProperty("source");
    expect(snap.rocks).toHaveLength(26);
    expect(snap.deposits).toHaveLength(61);
  });
});

describe("createMiningReference (bundled loader)", () => {
  it("serves the bundled snapshot with 26 rocks + 61 deposits", () => {
    const data = createMiningReference().getReferenceData();
    expect(data.rocks).toHaveLength(26);
    expect(data.deposits).toHaveLength(61);
  });

  it("isActive() is true for the bundled data and false for an empty override", () => {
    expect(createMiningReference().isActive()).toBe(true);
    expect(
      createMiningReference({
        snapshot: { rocks: [], deposits: [] },
      }).isActive(),
    ).toBe(false);
  });
});
