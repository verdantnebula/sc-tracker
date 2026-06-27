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
import {
  parseContractOcr,
  parseOcrNumber,
  cleanOcrSpan,
  cleanContractTitle,
} from "./ocrParse";

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
// Title cleaning + extraction (Part A)
// ---------------------------------------------------------------------------

describe("cleanContractTitle", () => {
  it("strips a trailing [BP]* tag and keeps pipe separators", () => {
    expect(
      cleanContractTitle(
        "Senior | Medium Haul | from MIC-L2 Long Forest Station [BP]*",
      ),
    ).toBe("Senior | Medium Haul | from MIC-L2 Long Forest Station");
  });

  it("normalizes OCR pipe spacing to a consistent ' | '", () => {
    expect(
      cleanContractTitle("Senior |Medium Haul|  from ARC-L1 Wide Forest"),
    ).toBe("Senior | Medium Haul | from ARC-L1 Wide Forest");
  });

  it("strips multiple trailing bracket tags and stray asterisks", () => {
    expect(cleanContractTitle("Bulk Cargo Haul [LG] [BP]*")).toBe(
      "Bulk Cargo Haul",
    );
  });
});

describe("parseContractOcr — title extraction", () => {
  it("reads the haul title from the header band, not the reward/flavor lines", () => {
    const text = [
      "Reward o 314,000",
      "Contract Deadline N/A",
      "Senior | Medium Haul | from MIC-L2 Long Forest Station [BP]*",
      "Contracted By Covalex Independent Contractors",
      "PRIMARY OBJECTIVES",
      "Deliver 0/66 SCU of Quartz to Seraphim Station above Crusader.",
      "Collect Quartz from MIC-L2 Long Forest Station.",
    ].join("\n");
    expect(parseContractOcr(text).title).toBe(
      "Senior | Medium Haul | from MIC-L2 Long Forest Station",
    );
  });

  it("does NOT pick up a Collect objective line or PRIMARY OBJECTIVES", () => {
    const text = [
      "Reward 100,000",
      "PRIMARY OBJECTIVES",
      "Collect Quartz from MIC-L2 Long Forest Station.",
    ].join("\n");
    // No header haul-title line present -> null (never a wrong guess).
    expect(parseContractOcr(text).title).toBeNull();
  });

  it("reads a Haul title with no pipes (keyword + from clause)", () => {
    const text = [
      "Reward 50,000",
      "Medium Cargo Haul from Port Tressler",
      "PRIMARY OBJECTIVES",
      "Deliver 0/40 SCU of Iron to Baijini Point.",
    ].join("\n");
    expect(parseContractOcr(text).title).toBe(
      "Medium Cargo Haul from Port Tressler",
    );
  });

  it("returns null when no title-shaped line is present", () => {
    const text = "Deliver 5 SCU of Iron to Baijini Point";
    expect(parseContractOcr(text).title).toBeNull();
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
      title: null,
    });
  });

  it("returns an empty result for non-string input (never throws)", () => {
    expect(parseContractOcr(undefined)).toEqual({
      objectives: [],
      reward: null,
      boxSize: null,
      title: null,
    });
    expect(parseContractOcr(42 as unknown)).toEqual({
      objectives: [],
      reward: null,
      boxSize: null,
      title: null,
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

// =============================================================================
// Bug #56 — Number / SCU hardening: a misread fraction slash must not merge two
// figures into one impossible SCU, and any SCU above a sane per-leg ceiling is
// rejected (the objective is kept but its scu is nulled so corruption can't be
// written). The three real corruptions observed in the field were 2318, 2992,
// and 7106 — each a fraction whose "/" OCR'd as a digit-lookalike glyph.
// =============================================================================

describe("parseContractOcr — SCU number hardening (Bug #56)", () => {
  it("treats a slash OCR'd as '7' as the fraction divider (0/106, not 7106)", () => {
    // "0/106" mis-OCR'd: the "/" became a "7" -> "07106". Without slash-lookalike
    // handling this parsed as the literal 7106. We must read it as 0-of-106 and
    // keep the DENOMINATOR (106).
    const out = parseContractOcr(
      "Deliver 07106 SCU of Quantum Fuel to Green Glade Station",
    );
    expect(out.objectives).toHaveLength(1);
    expect(out.objectives[0].scu).toBe(106);
  });

  it("treats a slash OCR'd as '1'/'l'/'I'/'|' as the fraction divider", () => {
    // Same misread, different lookalike glyph each time. Denominator wins.
    const variants: Array<[string, number]> = [
      ["Deliver 01106 SCU of Iron to Baijini Point", 106],
      ["Deliver 0l106 SCU of Iron to Baijini Point", 106],
      ["Deliver 0I106 SCU of Iron to Baijini Point", 106],
      ["Deliver 0|106 SCU of Iron to Baijini Point", 106],
    ];
    for (const [text, expected] of variants) {
      const out = parseContractOcr(text);
      expect(out.objectives[0].scu).toBe(expected);
    }
  });

  it("rejects an impossible merged SCU (2318) by nulling the amount", () => {
    // "23/18" with the "/" read as nothing -> "2318". Even if it slips past the
    // fraction logic, the sanity ceiling rejects it: the objective survives so the
    // user can fix it in review, but the garbage number is NOT written.
    const out = parseContractOcr(
      "Deliver 2318 SCU of Titanium to Everus Harbor",
    );
    expect(out.objectives).toHaveLength(1);
    expect(out.objectives[0].scu).toBeNull();
    expect(out.objectives[0].commodity).toBe("Titanium");
    expect(out.objectives[0].location).toBe("Everus Harbor");
  });

  it("rejects an impossible merged SCU (2992) by nulling the amount", () => {
    const out = parseContractOcr(
      "Deliver 2992 SCU of Hydrogen Fuel to Melodic Fields Station",
    );
    expect(out.objectives).toHaveLength(1);
    expect(out.objectives[0].scu).toBeNull();
    expect(out.objectives[0].commodity).toBe("Hydrogen Fuel");
  });

  it("rejects an impossible merged SCU (7106) by nulling the amount", () => {
    // A bare "7106" with no recoverable fraction structure: over the ceiling, so
    // null it rather than write a 7106-SCU leg.
    const out = parseContractOcr(
      "Deliver 7106 SCU of Ship Ammunition to Thundering Express Station",
    );
    expect(out.objectives).toHaveLength(1);
    expect(out.objectives[0].scu).toBeNull();
  });

  it("accepts an SCU exactly at the ceiling and rejects one just above it", () => {
    const ok = parseContractOcr("Deliver 696 SCU of Iron to Baijini Point");
    expect(ok.objectives[0].scu).toBe(696);
    const bad = parseContractOcr("Deliver 697 SCU of Iron to Baijini Point");
    expect(bad.objectives[0].scu).toBeNull();
  });

  it("still parses ordinary valid SCU amounts unchanged", () => {
    const cases: Array<[string, number]> = [
      ["Deliver 32 SCU of Titanium to Baijini Point", 32],
      ["Collect 18 SCU of Aluminum from Seraphim Station", 18],
      ["Deliver 0/46 SCU of Quantum Fuel to Green Glade Station", 46],
      [
        "Deliver 0/116 SCU of Ship Ammunition to Thundering Express Station",
        116,
      ],
      ["Deliver 696 SCU of Iron to Baijini Point", 696],
    ];
    for (const [text, expected] of cases) {
      expect(parseContractOcr(text).objectives[0].scu).toBe(expected);
    }
  });
});

// =============================================================================
// I1 — recoverMergedFraction must not mis-recover ambiguous leading-0 tokens.
//
// Round-1 anchored on a leading "0" and a digit-LOOKALIKE divider (7/1/|/l/I)
// too eagerly, so realistic OCR tokens were silently mis-recovered into plausible
// but WRONG SMALL values that passed the ceiling and were written:
//   "0106" -> 6,  "0716" -> 16,  "0796" -> 96   (correct totals: 106 / 716 / 796)
//
// Chosen behavior (documented here):
//   - A LITERAL "/" divider is unambiguous (a "/" is never a real digit), so we
//     recover the denominator at any length: "0/46" -> 46, "0/696" -> 696.
//   - A DIGIT-LOOKALIKE divider is ambiguous; we only recover when the split is
//     unambiguous: a single leading "0", the lookalike divider, then a PLAUSIBLE
//     denominator (3+ digits, no leading zero). The real favorable case
//     "07106" -> 106 still recovers. The ambiguous SHORT merges no longer emit a
//     guessed small value; instead the lone token falls through to parseOcrNumber
//     and is judged on its NUMERIC value:
//       "0106" -> 106  (== the correct total, and within the ceiling -> kept)
//       "0716" -> 716  (correct total, but over the 696 ceiling -> rejected/null)
//       "0796" -> 796  (correct total, but over the ceiling -> rejected/null)
//     In every case the WRONG small value (6 / 16 / 96) is gone: either the right
//     total is read, or the amount is routed to review (null) — never silent
//     corruption.
// =============================================================================

describe("parseContractOcr — leading-0 merge ambiguity (I1)", () => {
  it("no longer emits the WRONG small value for an ambiguous leading-0 token", () => {
    // "0106" numerically equals its correct total (106) and is within the
    // ceiling, so it is read correctly — NOT the round-1 mis-recovery to 6.
    expect(
      parseContractOcr("Deliver 0106 SCU of Iron to Baijini Point")
        .objectives[0].scu,
    ).toBe(106);

    // "0716"/"0796" equal totals above the 696 ceiling, so rather than the
    // round-1 wrong small values (16 / 96) they are rejected -> null (routed to
    // review via the C1 placeholder path). The key guarantee: never 16 / 96.
    for (const text of [
      "Deliver 0716 SCU of Iron to Baijini Point",
      "Deliver 0796 SCU of Iron to Baijini Point",
    ]) {
      const scu = parseContractOcr(text).objectives[0].scu;
      expect(scu).toBeNull();
    }
  });

  it("STILL recovers the unambiguous favorable lookalike + literal-slash cases", () => {
    // The plausible-denominator (3+ digit) lookalike case and every literal-slash
    // case must remain green — the fix only tightens the AMBIGUOUS short merges.
    const cases: Array<[string, number]> = [
      ["Deliver 07106 SCU of Quantum Fuel to Green Glade Station", 106],
      ["Deliver 0/46 SCU of Quantum Fuel to Green Glade Station", 46],
      ["Deliver 0/116 SCU of Ship Ammunition to Baijini Point", 116],
      ["Deliver 0/696 SCU of Iron to Baijini Point", 696],
      // lookalike divider variants with a plausible 3-digit denominator.
      ["Deliver 01106 SCU of Iron to Baijini Point", 106],
      ["Deliver 0l106 SCU of Iron to Baijini Point", 106],
      ["Deliver 0I106 SCU of Iron to Baijini Point", 106],
      ["Deliver 0|106 SCU of Iron to Baijini Point", 106],
    ];
    for (const [text, expected] of cases) {
      expect(parseContractOcr(text).objectives[0].scu).toBe(expected);
    }
  });
});

// =============================================================================
// C1 — a resolved SCU of literal 0 is corruption, never real 0 cargo.
//
// A delivery/collection objective is never legitimately 0 SCU, so a resolved 0
// (or any non-positive value) means the amount was unreadable and must collapse
// to null — NOT pass through as a known 0. Realistic OCR corruptions produce a
// resolved 0: a literal "0" amount, the letter "O" misread as 0, "00", "0/0",
// and a 0/zero-lookalike-denominator fraction. clampScu/pickScu now enforce the
// contract "positive number or null, never a literal 0", so the downstream store
// never locks a corrupt 0-SCU leg as user-confirmed cargo. All previously
// favorable cases (real positives, fraction denominators, over-ceiling -> null)
// must stay green.
// =============================================================================

describe("parseContractOcr — zero SCU is corruption, collapses to null (C1)", () => {
  const zeroCases: Array<[string, string]> = [
    // [text, the corruption it guards]
    ["Deliver 0 SCU of Titanium to Everus Harbor", "literal 0 amount"],
    ["Collect O SCU of Quartz from Port Tressler", "letter O misread as 0"],
    ["Deliver 00 SCU of Iron to Baijini Point", "doubled-zero misread"],
    ["Deliver 0/0 SCU of Iron to Baijini Point", "0/0 fraction (zero denom)"],
    // 0 / zero-lookalike denominator ("O" denom de-confuses to 0 -> total 0).
    ["Deliver 0/O SCU of Iron to Baijini Point", "0/<zero-lookalike denom>"],
  ];
  it.each(zeroCases)("yields scu null (not 0) for %s", (text) => {
    const out = parseContractOcr(text);
    expect(out.objectives.length).toBe(1);
    // The objective is KEPT (commodity/location intact) but the amount is null,
    // so the store routes it to a fillable placeholder, never real 0 cargo.
    expect(out.objectives[0].scu).toBeNull();
  });

  it("keeps every favorable SCU case green (positives, fractions, over-ceiling)", () => {
    // Positives + fraction denominators are unchanged; over-ceiling still nulls.
    const cases: Array<[string, number | null]> = [
      ["Deliver 32 SCU of Titanium to Baijini Point", 32],
      ["Deliver 07106 SCU of Quantum Fuel to Green Glade Station", 106],
      ["Deliver 0/46 SCU of Quantum Fuel to Green Glade Station", 46],
      ["Deliver 0/116 SCU of Ship Ammunition to Baijini Point", 116],
      ["Deliver 0/696 SCU of Iron to Baijini Point", 696],
      // lookalike-divider variants with a plausible 3-digit denominator.
      ["Deliver 01106 SCU of Iron to Baijini Point", 106],
      ["Deliver 0l106 SCU of Iron to Baijini Point", 106],
      ["Deliver 696 SCU of Iron to Baijini Point", 696],
      ["Deliver 697 SCU of Iron to Baijini Point", null], // over-ceiling
    ];
    for (const [text, expected] of cases) {
      expect(parseContractOcr(text).objectives[0].scu).toBe(expected);
    }
  });
});

// =============================================================================
// Bug #57 — Prose / over-capture rejection: a full-screen capture lets the
// DETAILS column bleed prose into the location span. A blocklist of words that
// never appear in a station name, a "no second preposition" rule, and a
// station-type suffix anchor must trim the location back to the place name
// WITHOUT over-cutting legitimate multi-word names.
// =============================================================================

describe("parseContractOcr — prose over-capture rejection (Bug #57)", () => {
  it("drops a destination at a blocklist prose word (refinery/looking/etc.)", () => {
    const cases: Array<[string, string]> = [
      [
        "Deliver 12 SCU of Titanium to Everus Harbor above j The refinery at Shallow Fields",
        "Everus Harbor",
      ],
      [
        "Deliver 1 SCU of Quantum Fuel to CRU-L4 Shallow Fields are looking to get the containers",
        "CRU-L4 Shallow Fields",
      ],
      [
        "Deliver 5 SCU of Iron to Baijini Point seems the contractors are waiting",
        "Baijini Point",
      ],
      [
        "Deliver 5 SCU of Iron to Port Tressler please contact the processed shipment",
        "Port Tressler",
      ],
    ];
    for (const [text, expected] of cases) {
      expect(parseContractOcr(text).objectives[0].location).toBe(expected);
    }
  });

  it("trims at a SECOND preposition that bled into the location", () => {
    // The location span absorbed another "to"/"from" from following prose.
    const out = parseContractOcr(
      "Deliver 5 SCU of Iron to Green Glade Station to be processed by the crew",
    );
    expect(out.objectives[0].location).toBe("Green Glade Station");
  });

  it("anchors to a station-type suffix and cuts trailing prose after it", () => {
    const out = parseContractOcr(
      "Deliver 5 SCU of Iron to Thundering Express Station and the freight elevator is ready",
    );
    expect(out.objectives[0].location).toBe("Thundering Express Station");
  });

  it("keeps a trailing pad code after the station-type suffix", () => {
    // A real station name can carry a pad/dock code (e.g. "S4DC05") AFTER the
    // station-type word; the anchor must keep it.
    const out = parseContractOcr(
      "Deliver 5 SCU of Iron to Everus Harbor Station S4DC05 seems busy today",
    );
    expect(out.objectives[0].location).toBe("Everus Harbor Station S4DC05");
  });

  it("does NOT over-cut legitimate multi-word station names", () => {
    const cases: Array<[string, string]> = [
      [
        "Deliver 5 SCU of Iron to Thundering Express Station",
        "Thundering Express Station",
      ],
      ["Deliver 5 SCU of Iron to Green Glade Station", "Green Glade Station"],
      ["Deliver 5 SCU of Iron to Port Tressler", "Port Tressler"],
      ["Collect Quantum Fuel from Everus Harbor", "Everus Harbor"],
      [
        "Deliver 5 SCU of Iron to CRU-L4 Shallow Fields",
        "CRU-L4 Shallow Fields",
      ],
    ];
    for (const [text, expected] of cases) {
      expect(parseContractOcr(text).objectives[0].location).toBe(expected);
    }
  });
});

// =============================================================================
// CRU-L4 two-column header capture — the reconstructed text after the header band
// is split column-aware (title on its own line(s), reward block on its own
// line(s)). This is what isolateObjectivesColumn now produces for the CRU-L4
// Shallow Fields contract; the parser must read a CLEAN title (no reward bleed)
// AND the reward 345500, plus the 4 Aluminum/Tungsten deliveries.
// (SANITIZED + SYNTHETIC; game contract data only, no personal data.)
// =============================================================================

describe("parseContractOcr — CRU-L4 two-column header (clean title + reward)", () => {
  const cleanedColumn = [
    // LEFT title column (reconstructed as its own line — no reward bleed):
    "Senior | Medium Haul | from CRU-L4 Shallow Fields Station [BP]*",
    // RIGHT reward block (its own separate lines):
    "Reward H 345,500",
    "Contract Deadline N/A",
    "Contracted By Covalex Independent Contractors",
    "PRIMARY OBJECTIVES",
    "Deliver 0/91 SCU of Aluminum to Everus Harbor above Hurston.",
    "Deliver 0/77 SCU of Aluminum to Port Tressler above microTech.",
    "Deliver 0/88 SCU of Tungsten to Baijini Point above ArcCorp.",
    "Deliver 0/71 SCU of Tungsten to Everus Harbor above Hurston.",
  ].join("\n");

  it("reads the CLEAN title with no reward bleed", () => {
    expect(parseContractOcr(cleanedColumn).title).toBe(
      "Senior | Medium Haul | from CRU-L4 Shallow Fields Station",
    );
  });

  it("extracts the reward 345500 from the now-separate reward line", () => {
    expect(parseContractOcr(cleanedColumn).reward).toBe(345500);
  });

  it("recovers exactly 4 deliveries with the right SCU / commodity / dest", () => {
    const out = parseContractOcr(cleanedColumn);
    const dropoffs = out.objectives.filter((o) => o.kind === "dropoff");
    expect(dropoffs).toHaveLength(4);
    expect(dropoffs).toEqual([
      {
        kind: "dropoff",
        scu: 91,
        commodity: "Aluminum",
        location: "Everus Harbor",
      },
      {
        kind: "dropoff",
        scu: 77,
        commodity: "Aluminum",
        location: "Port Tressler",
      },
      {
        kind: "dropoff",
        scu: 88,
        commodity: "Tungsten",
        location: "Baijini Point",
      },
      {
        kind: "dropoff",
        scu: 71,
        commodity: "Tungsten",
        location: "Everus Harbor",
      },
    ]);
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

// =============================================================================
// Bug 1b — location bleed: full-screen captures let the DETAILS column bleed
// into the location span (the span runs until the next verb). trimDestination
// must cut an " above <body>" qualifier and conservative prose lead-ins, WITHOUT
// over-cutting legitimate multi-word station names.
// =============================================================================

describe("parseContractOcr — location bleed (trimDestination hardening)", () => {
  it("strips a trailing ' above <body>' qualifier from a destination", () => {
    const out = parseContractOcr(
      "Deliver 12 SCU of Titanium to Everus Harbor above Hurston",
    );
    expect(out.objectives).toHaveLength(1);
    expect(out.objectives[0].location).toBe("Everus Harbor");
  });

  it("strips ' above <body>' even when prose bleeds in after it", () => {
    const out = parseContractOcr(
      "Deliver 12 SCU of Titanium to Everus Harbor above j The refinery at Shallow Fields Stat",
    );
    expect(out.objectives[0].location).toBe("Everus Harbor");
  });

  it("cuts a prose lead-in ('are looking') that bled into the location", () => {
    const out = parseContractOcr(
      "Deliver 1 SCU of Quantum Fuel to CRU-L4 Shallow Fields are looking to get the containers 1",
    );
    expect(out.objectives[0].location).toBe("CRU-L4 Shallow Fields");
  });

  it("does NOT over-cut a legitimate multi-word station name", () => {
    // None of the terminator tokens appear, so the full name must survive.
    const cases: Array<[string, string]> = [
      [
        "Deliver 5 SCU of Iron to Thundering Express Station",
        "Thundering Express Station",
      ],
      ["Deliver 5 SCU of Iron to Green Glade Station", "Green Glade Station"],
      ["Deliver 5 SCU of Iron to Port Tressler", "Port Tressler"],
    ];
    for (const [text, expected] of cases) {
      expect(parseContractOcr(text).objectives[0].location).toBe(expected);
    }
  });
});

// =============================================================================
// END-TO-END-ISH: the cleaned PRIMARY OBJECTIVES column text (what
// isolateObjectivesColumn produces from a full-screen two-column capture) feeds
// the parser. This is the REAL Quartz contract structure: FOUR explicit
// "Deliver N SCU of Quartz to <station> above <body>" deliveries (66/67/105/69),
// each paired with its own "Collect Quartz from <pickup>" sub-objective. Each
// Deliver line is its OWN leg — NOT collapsed into a single Deliver + an
// "ANY ORDER" station list (that earlier heuristic modeled an OCR misread and
// was removed). The standard per-line parser must yield 4 DISTINCT delivers with
// the correct SCU each + the Collect pickups.
// (SANITIZED + SYNTHETIC title text; game contract data only, no personal data.)
// =============================================================================

describe("parseContractOcr — real Quartz multi-delivery structure", () => {
  // The text isolateObjectivesColumn yields for the documented Quartz contract:
  // header band (reward + title) + the explicit per-line Deliver/Collect objectives.
  const cleanedColumn = [
    "Reward o 314,000",
    "Senior | Medium Haul | from MIC-L2 Long Forest Station [BP]*",
    "Contracted By Covalex Independent Contractors",
    "PRIMARY OBJECTIVES",
    "Deliver 0/66 SCU of Quartz to Seraphim Station above Crusader.",
    "Collect Quartz from MIC-L2 Long Forest Station.",
    "Deliver 0/67 SCU of Quartz to Baijini Point above ArcCorp.",
    "Collect Quartz from MIC-L2 Long Forest Station.",
    "Deliver 0/105 SCU of Quartz to Port Tressler above microTech.",
    "Collect Quartz from MIC-L2 Long Forest Station.",
    "Deliver 0/69 SCU of Quartz to Everus Harbor above Hurston.",
    "Collect Quartz from MIC-L2 Long Forest Station.",
  ].join("\n");

  it("recovers the reward (314,000)", () => {
    expect(parseContractOcr(cleanedColumn).reward).toBe(314000);
  });

  it("recovers exactly 4 DISTINCT deliver legs with SCU 66/67/105/69", () => {
    const out = parseContractOcr(cleanedColumn);
    const dropoffs = out.objectives.filter((o) => o.kind === "dropoff");
    expect(dropoffs).toHaveLength(4);
    // Each delivery is its own leg — SCU is the per-leg denominator, NOT
    // collapsed onto one leg nor multiplied across legs.
    expect(dropoffs.map((d) => d.scu)).toEqual([66, 67, 105, 69]);
  });

  it("recovers each delivery's commodity (Quartz) and destination", () => {
    const out = parseContractOcr(cleanedColumn);
    const dropoffs = out.objectives.filter((o) => o.kind === "dropoff");
    for (const d of dropoffs) expect(d.commodity).toBe("Quartz");
    // The " above <body>" qualifier is stripped; the station name remains.
    expect(dropoffs.map((d) => d.location)).toEqual([
      "Seraphim Station",
      "Baijini Point",
      "Port Tressler",
      "Everus Harbor",
    ]);
  });

  it("recovers the Collect pickups from MIC-L2 Long Forest Station", () => {
    const out = parseContractOcr(cleanedColumn);
    const pickups = out.objectives.filter((o) => o.kind === "pickup");
    expect(pickups).toHaveLength(4);
    for (const p of pickups) {
      expect(p.commodity).toBe("Quartz");
      expect(p.location).toBe("MIC-L2 Long Forest Station");
      expect(p.scu).toBeNull();
    }
  });

  it("parses the contract title from the header band", () => {
    expect(parseContractOcr(cleanedColumn).title).toBe(
      "Senior | Medium Haul | from MIC-L2 Long Forest Station",
    );
  });
});
