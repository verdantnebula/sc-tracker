// ============================================================================
// ocrParse.test.ts — pure mobiGlas-contract OCR parser (Phase F, EXPERIMENTAL)
// ----------------------------------------------------------------------------
// EVERY fixture below is SANITIZED + SYNTHETIC. No real screenshots, no real
// Game.log, no personal data — these are hand-authored strings that mimic what
// tesseract.js would emit from the contract screen, including deliberate OCR
// noise (O/0, l/1, lowercase "scu", stray punctuation, thousands separators).
// Locations/commodities use generic in-fiction names only.
//
// Coverage (per spec): standard objective line, suppressed-variant phrasing,
// reward parsing, no-match/garbled input, multi-objective.
// ============================================================================

import { describe, expect, it } from "vitest";
import { parseContractOcr, parseOcrNumber, cleanOcrSpan } from "./ocrParse";

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

describe("parseOcrNumber", () => {
  it("parses a clean integer", () => {
    expect(parseOcrNumber("32")).toBe(32);
  });

  it("strips thousands separators", () => {
    expect(parseOcrNumber("45,000")).toBe(45000);
    expect(parseOcrNumber("1.250")).toBe(1250);
    expect(parseOcrNumber("12 500")).toBe(12500);
  });

  it("de-confuses common OCR letter/digit swaps inside a numeric span", () => {
    // O->0, l->1, S->5, B->8
    expect(parseOcrNumber("1O")).toBe(10);
    expect(parseOcrNumber("l6")).toBe(16);
    expect(parseOcrNumber("5OO")).toBe(500);
    expect(parseOcrNumber("B0")).toBe(80);
  });

  it("returns null when nothing digit-like survives", () => {
    expect(parseOcrNumber("")).toBeNull();
    expect(parseOcrNumber("----")).toBeNull();
    expect(parseOcrNumber("xyz" as unknown as string)).toBe(null);
  });
});

describe("cleanOcrSpan", () => {
  it("collapses whitespace and trims edge punctuation", () => {
    expect(cleanOcrSpan("  Baijini   Point. ")).toBe("Baijini Point");
    expect(cleanOcrSpan(">> Agricium <<")).toBe("Agricium");
  });
});

// ---------------------------------------------------------------------------
// Standard objective line
// ---------------------------------------------------------------------------

describe("parseContractOcr — standard objective", () => {
  it("parses a clean Deliver line into a dropoff objective", () => {
    const text = "Deliver 32 SCU of Titanium to Baijini Point";
    const out = parseContractOcr(text);
    expect(out.objectives).toHaveLength(1);
    expect(out.objectives[0]).toEqual({
      kind: "dropoff",
      scu: 32,
      commodity: "Titanium",
      location: "Baijini Point",
    });
  });

  it("parses a clean Collect line into a pickup objective", () => {
    const text = "Collect 18 SCU of Aluminum from Seraphim Station";
    const out = parseContractOcr(text);
    expect(out.objectives).toHaveLength(1);
    expect(out.objectives[0]).toEqual({
      kind: "pickup",
      scu: 18,
      commodity: "Aluminum",
      location: "Seraphim Station",
    });
  });
});

// ---------------------------------------------------------------------------
// Suppressed-variant phrasing / OCR noise (the reason this feature exists)
// ---------------------------------------------------------------------------

describe("parseContractOcr — noisy / suppressed-variant phrasing", () => {
  it("tolerates lowercase unit, '5CU' confusion and stray punctuation", () => {
    // lowercase verb, "5cu", extra dots — what a stylized-font OCR pass produces.
    const text = "deliver 4 5cu of Processed Food to Everus Harbor.";
    const out = parseContractOcr(text);
    expect(out.objectives).toHaveLength(1);
    expect(out.objectives[0].kind).toBe("dropoff");
    expect(out.objectives[0].scu).toBe(4);
    expect(out.objectives[0].commodity).toBe("Processed Food");
    expect(out.objectives[0].location).toBe("Everus Harbor");
  });

  it("recovers an SCU amount mangled with O/l confusions", () => {
    const text = "Deliver lO SCU of Quartz to Port Olisar";
    const out = parseContractOcr(text);
    expect(out.objectives[0].scu).toBe(10);
    expect(out.objectives[0].commodity).toBe("Quartz");
  });

  it("accepts 'Pick up' as a pickup synonym", () => {
    const text = "Pick up 6 SCU of Hydrogen from Area 18";
    const out = parseContractOcr(text);
    expect(out.objectives).toHaveLength(1);
    expect(out.objectives[0].kind).toBe("pickup");
    expect(out.objectives[0].location).toBe("Area 18");
  });

  it("keeps the objective even when the SCU number is unreadable (null)", () => {
    const text = "Deliver -- SCU of Tungsten to Lorville";
    const out = parseContractOcr(text);
    expect(out.objectives).toHaveLength(1);
    expect(out.objectives[0].scu).toBeNull();
    expect(out.objectives[0].commodity).toBe("Tungsten");
    expect(out.objectives[0].location).toBe("Lorville");
  });
});

// ---------------------------------------------------------------------------
// Reward parsing
// ---------------------------------------------------------------------------

describe("parseContractOcr — reward", () => {
  it("parses reward adjacent to aUEC with a thousands separator", () => {
    const out = parseContractOcr("Reward 45,000 aUEC");
    expect(out.reward).toBe(45000);
  });

  it("tolerates lowercase 'auec' and OCR digit confusion", () => {
    const out = parseContractOcr("Payout: 12,5OO auec");
    expect(out.reward).toBe(12500);
  });

  it("falls back to a Reward/Payout label when the unit is missing", () => {
    const out = parseContractOcr("Reward: 8000");
    expect(out.reward).toBe(8000);
  });

  it("picks the largest aUEC figure as the contract reward", () => {
    // A contract screen may show a smaller bonus/fee line too.
    const text = "Bonus 500 aUEC\nReward 30,000 aUEC";
    const out = parseContractOcr(text);
    expect(out.reward).toBe(30000);
  });

  it("returns null reward when none is present", () => {
    const out = parseContractOcr("Deliver 5 SCU of Stims to Grim HEX");
    expect(out.reward).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Box size
// ---------------------------------------------------------------------------

describe("parseContractOcr — box size", () => {
  it("parses a max box size line when present", () => {
    const out = parseContractOcr("Max Box Size 1 SCU");
    expect(out.boxSize).toBe(1);
  });

  it("parses a container size variant", () => {
    const out = parseContractOcr("Container size: 4 SCU");
    expect(out.boxSize).toBe(4);
  });

  it("is null when no box-size line is present", () => {
    const out = parseContractOcr("Deliver 8 SCU of Iron to Baijini Point");
    expect(out.boxSize).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// No-match / garbled input
// ---------------------------------------------------------------------------

describe("parseContractOcr — garbled / empty input", () => {
  it("returns an empty result for empty input", () => {
    expect(parseContractOcr("")).toEqual({
      objectives: [],
      reward: null,
      boxSize: null,
    });
  });

  it("returns an empty result for non-string input (never throws)", () => {
    expect(parseContractOcr(undefined)).toEqual({
      objectives: [],
      reward: null,
      boxSize: null,
    });
    expect(parseContractOcr(42 as unknown)).toEqual({
      objectives: [],
      reward: null,
      boxSize: null,
    });
  });

  it("returns no objectives for pure noise with no contract keywords", () => {
    const out = parseContractOcr("####  >>>  ::: ___ \n %%% &&&");
    expect(out.objectives).toEqual([]);
    expect(out.reward).toBeNull();
    expect(out.boxSize).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Multi-objective (single-to-multi haul) + full contract
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// REAL mobiGlas format (the canonical fixture this feature must handle)
// ----------------------------------------------------------------------------
// This is the ACTUAL raw text tesseract produced from a captured contract screen
// (game data only — no personal info). It exercises the format the parser MUST
// handle: fractional SCU ("0/46"), the aUEC glyph OCR'd as a stray "a", a pickup
// line with NO "SCU of", destinations carrying an " at … Lagrange point"
// qualifier, a stray trailing "j" speckle, and — critically — destination/
// commodity names WRAPPED across lines ("Melodic Fields" + "Station").
// ---------------------------------------------------------------------------

describe("parseContractOcr — real mobiGlas contract format", () => {
  const REAL_OCR = [
    "Reward a 290,500",
    "Contract Deadline N/A",
    "Contracted B, Covalex Independent Contractors",
    "PRIMARY OBJECTIVES",
    "Deliver 0/46 SCU of Quantum Fuel to Green Glade Station j",
    "at Hurstons L1 Lagrange point.",
    "Collect Quantum Fuel from Everus Harbor.",
    "Deliver 0/94 SCU of Hydrogen Fuel to Melodic Fields",
    "Station at Hurstons L4 Lagrange point.",
  ].join("\n");

  it("extracts the reward despite the aUEC glyph reading as a stray 'a'", () => {
    expect(parseContractOcr(REAL_OCR).reward).toBe(290500);
  });

  it("extracts both dropoffs (fractional SCU total, wrapped/qualified dest)", () => {
    const out = parseContractOcr(REAL_OCR);
    const dropoffs = out.objectives.filter((o) => o.kind === "dropoff");
    expect(dropoffs).toHaveLength(2);

    // SCU = the DENOMINATOR (contract total), not the delivered numerator.
    // Lagrange qualifier dropped; wrapped "Melodic Fields" + "Station" rejoined;
    // stray trailing "j" stripped from "Green Glade Station".
    expect(dropoffs[0]).toEqual({
      kind: "dropoff",
      scu: 46,
      commodity: "Quantum Fuel",
      location: "Green Glade Station",
    });
    expect(dropoffs[1]).toEqual({
      kind: "dropoff",
      scu: 94,
      commodity: "Hydrogen Fuel",
      location: "Melodic Fields Station",
    });
  });

  it("extracts the pickup line that has NO 'SCU of' wording", () => {
    const out = parseContractOcr(REAL_OCR);
    const pickups = out.objectives.filter((o) => o.kind === "pickup");
    expect(pickups).toHaveLength(1);
    expect(pickups[0]).toEqual({
      kind: "pickup",
      scu: null,
      commodity: "Quantum Fuel",
      location: "Everus Harbor",
    });
  });

  it("recovers exactly 3 objectives total from the real screen", () => {
    expect(parseContractOcr(REAL_OCR).objectives).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// REAL mobiGlas format — FULL multi-leg contract (regression)
// ----------------------------------------------------------------------------
// The ACTUAL raw tesseract text from a larger captured contract (game data only,
// no personal info): a SINGLE pickup hub (Everus Harbor) feeding FOUR deliveries.
// It is the stress case the smaller fixture above only partially covers:
//   - 4 dropoffs + 4 pickups in interleaved (deliver, collect, …) order,
//   - destination/commodity names WRAPPED mid-name across lines
//     ("Melodic Fields" + "Station", "Thundering" + "Express Station"),
//   - the aUEC glyph OCR'd as a stray "a", fractional SCU ("0/46"),
//     " at … Lagrange point" qualifiers, a trailing "j" speckle,
//   - CRITICALLY a REPEATED destination (Green Glade Station appears twice with
//     different commodity/SCU) and a REPEATED commodity (Hydrogen Fuel delivered
//     to two different stations) — neither must be deduped/merged: each objective
//     is its own leg.
// ---------------------------------------------------------------------------

describe("parseContractOcr — full multi-leg contract (repeated dest/commodity)", () => {
  const FULL_OCR = [
    "Reward a 290,500",
    "Contract Deadline N/A",
    "Contracted B, Covalex Independent Contractors",
    "PRIMARY OBJECTIVES",
    "Deliver 0/46 SCU of Quantum Fuel to Green Glade Station j",
    "at Hurstons L1 Lagrange point.",
    "Collect Quantum Fuel from Everus Harbor.",
    "Deliver 0/94 SCU of Hydrogen Fuel to Melodic Fields",
    "Station at Hurstons L4 Lagrange point.",
    "Collect Hydrogen Fuel from Everus Harbor.",
    "Deliver 0/116 SCU of Ship Ammunition to Thundering",
    "Express Station at Hurstons L3 Lagrange point.",
    "Collect Ship Ammunition from Everus Harbor.",
    "Deliver 0/53 SCU of Hydrogen Fuel to Green Glade Station",
    "at Hurstons L1 Lagrange point.",
    "Collect Hydrogen Fuel from Everus Harbor.",
  ].join("\n");

  it("extracts the reward (aUEC glyph read as a stray 'a')", () => {
    expect(parseContractOcr(FULL_OCR).reward).toBe(290500);
  });

  it("extracts all 4 dropoffs in order, with wraps/qualifiers/speckle handled", () => {
    const out = parseContractOcr(FULL_OCR);
    const dropoffs = out.objectives.filter((o) => o.kind === "dropoff");
    expect(dropoffs).toHaveLength(4);

    // SCU is the DENOMINATOR (contract total). Lagrange qualifiers dropped;
    // wrapped "Melodic Fields"/"Station" and "Thundering"/"Express Station"
    // rejoined; stray trailing "j" stripped from the first Green Glade dest.
    expect(dropoffs[0]).toEqual({
      kind: "dropoff",
      scu: 46,
      commodity: "Quantum Fuel",
      location: "Green Glade Station",
    });
    expect(dropoffs[1]).toEqual({
      kind: "dropoff",
      scu: 94,
      commodity: "Hydrogen Fuel",
      location: "Melodic Fields Station",
    });
    expect(dropoffs[2]).toEqual({
      kind: "dropoff",
      scu: 116,
      commodity: "Ship Ammunition",
      location: "Thundering Express Station",
    });
    expect(dropoffs[3]).toEqual({
      kind: "dropoff",
      scu: 53,
      commodity: "Hydrogen Fuel",
      location: "Green Glade Station",
    });
  });

  it("extracts all 4 'Collect … from Everus Harbor' pickups in order", () => {
    const out = parseContractOcr(FULL_OCR);
    const pickups = out.objectives.filter((o) => o.kind === "pickup");
    expect(pickups).toHaveLength(4);
    expect(pickups.map((p) => p.commodity)).toEqual([
      "Quantum Fuel",
      "Hydrogen Fuel",
      "Ship Ammunition",
      "Hydrogen Fuel",
    ]);
    // Every pickup is from the single hub; no SCU on the real pickup wording.
    for (const p of pickups) {
      expect(p.location).toBe("Everus Harbor");
      expect(p.scu).toBeNull();
    }
  });

  it("does NOT dedupe a repeated destination (Green Glade twice = TWO legs)", () => {
    const out = parseContractOcr(FULL_OCR);
    const greenGlade = out.objectives.filter(
      (o) => o.kind === "dropoff" && o.location === "Green Glade Station",
    );
    expect(greenGlade).toHaveLength(2);
    // Same destination, but distinct commodity/SCU — kept as separate legs.
    expect(greenGlade.map((o) => o.commodity)).toEqual([
      "Quantum Fuel",
      "Hydrogen Fuel",
    ]);
    expect(greenGlade.map((o) => o.scu)).toEqual([46, 53]);
  });

  it("does NOT dedupe a repeated commodity (Hydrogen Fuel to two stations)", () => {
    const out = parseContractOcr(FULL_OCR);
    const hydrogen = out.objectives.filter(
      (o) => o.kind === "dropoff" && o.commodity === "Hydrogen Fuel",
    );
    expect(hydrogen).toHaveLength(2);
    expect(hydrogen.map((o) => o.location)).toEqual([
      "Melodic Fields Station",
      "Green Glade Station",
    ]);
    expect(hydrogen.map((o) => o.scu)).toEqual([94, 53]);
  });

  it("recovers exactly 8 objectives total (4 dropoffs + 4 pickups)", () => {
    expect(parseContractOcr(FULL_OCR).objectives).toHaveLength(8);
  });
});

describe("parseContractOcr — multi-objective contract", () => {
  it("parses several objectives and the reward from one screen", () => {
    const text = [
      "Cargo Hauling Contract",
      "Collect 40 SCU of Agricultural Supplies from Port Tressler",
      "Deliver 15 SCU of Agricultural Supplies to Baijini Point",
      "Deliver 25 SCU of Agricultural Supplies to Everus Harbor",
      "Max Box Size 2 SCU",
      "Reward 62,500 aUEC",
    ].join("\n");

    const out = parseContractOcr(text);

    // 1 pickup + 2 dropoffs.
    const pickups = out.objectives.filter((o) => o.kind === "pickup");
    const dropoffs = out.objectives.filter((o) => o.kind === "dropoff");
    expect(pickups).toHaveLength(1);
    expect(dropoffs).toHaveLength(2);

    expect(pickups[0]).toEqual({
      kind: "pickup",
      scu: 40,
      commodity: "Agricultural Supplies",
      location: "Port Tressler",
    });
    expect(dropoffs.map((d) => d.location).sort()).toEqual([
      "Baijini Point",
      "Everus Harbor",
    ]);
    expect(dropoffs.map((d) => d.scu).sort()).toEqual([15, 25]);

    expect(out.reward).toBe(62500);
    expect(out.boxSize).toBe(2);
  });
});
