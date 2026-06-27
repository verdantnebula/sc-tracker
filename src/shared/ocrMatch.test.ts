// ============================================================================
// ocrMatch.test.ts — pure fuzzy matcher for OCR spans (Phase F, EXPERIMENTAL)
// ----------------------------------------------------------------------------
// All candidate lists below are SANITIZED + SYNTHETIC generic in-fiction names.
// No personal data, no real reference dump — just enough to exercise exact /
// noisy / containment / no-match behavior of fuzzyMatch and its helpers.
// ============================================================================

import { describe, expect, it } from "vitest";
import {
  fuzzyMatch,
  levenshtein,
  matchTitleToMissions,
  normalizeForMatch,
  similarity,
} from "./ocrMatch";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("normalizeForMatch", () => {
  it("lowercases and strips non-alphanumerics", () => {
    expect(normalizeForMatch("Baijini Point")).toBe("baijinipoint");
    expect(normalizeForMatch("S4DC-04 Depot.")).toBe("s4dc04depot");
  });
});

describe("levenshtein", () => {
  it("is 0 for identical strings", () => {
    expect(levenshtein("titanium", "titanium")).toBe(0);
  });
  it("counts single-character edits", () => {
    expect(levenshtein("titanium", "titanum")).toBe(1); // deletion
    expect(levenshtein("aluminum", "aluminun")).toBe(1); // substitution
  });
  it("handles empty strings", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });
});

describe("similarity", () => {
  it("is 1 for identical, lower for divergent", () => {
    expect(similarity("titanium", "titanium")).toBe(1);
    expect(similarity("titanium", "titanum")).toBeGreaterThan(0.8);
    expect(similarity("titanium", "xxxxxxxx")).toBeLessThan(0.2);
  });
  it("treats empty-vs-empty as a full match", () => {
    expect(similarity("", "")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// fuzzyMatch — exact
// ---------------------------------------------------------------------------

const COMMODITIES = [
  "Titanium",
  "Aluminum",
  "Agricultural Supplies",
  "Processed Food",
  "Quartz",
];

const LOCATIONS = [
  "Baijini Point",
  "Everus Harbor",
  "Seraphim Station",
  "Port Tressler",
  "Area 18",
];

describe("fuzzyMatch — exact / normalized equality", () => {
  it("returns the candidate with score 1 on an exact match", () => {
    const r = fuzzyMatch("Titanium", COMMODITIES);
    expect(r.value).toBe("Titanium");
    expect(r.score).toBe(1);
  });

  it("matches ignoring case and spacing", () => {
    const r = fuzzyMatch("baijini  point", LOCATIONS);
    expect(r.value).toBe("Baijini Point");
    expect(r.score).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// fuzzyMatch — noisy / near-miss (the OCR case)
// ---------------------------------------------------------------------------

describe("fuzzyMatch — noisy input", () => {
  it("matches a name with a few OCR-dropped/garbled characters", () => {
    // "Aluminun" (m->n) and a missing letter still resolve to Aluminum.
    const r = fuzzyMatch("Aluminun", COMMODITIES);
    expect(r.value).toBe("Aluminum");
    expect(r.score).toBeGreaterThan(0.6);
    expect(r.score).toBeLessThan(1);
  });

  it("matches a truncated location via the containment boost", () => {
    // OCR read only the first word of a two-word station name.
    const r = fuzzyMatch("Seraphim", LOCATIONS);
    expect(r.value).toBe("Seraphim Station");
    expect(r.score).toBeGreaterThan(0.6);
  });

  it("picks the closest of several similar candidates", () => {
    const r = fuzzyMatch("Agricultural Supplie", COMMODITIES);
    expect(r.value).toBe("Agricultural Supplies");
  });

  it("matches a station name against a Lagrange-PREFIXED reference entry", () => {
    // The OCR parser strips the " at … Lagrange point" qualifier and feeds the
    // bare station name, but the reference entries carry a Lagrange PREFIX
    // (e.g. "L1 <name> Station"). The containment boost bridges that gap so the
    // bare name still resolves to the prefixed reference entry. (Generic
    // synthetic names mirroring the real "Green Glade"/"Melodic Fields" shape.)
    const PREFIXED = [
      "L1 Green Glade Station",
      "L4 Melodic Fields Station",
      "Everus Harbor",
    ];
    const a = fuzzyMatch("Green Glade Station", PREFIXED);
    expect(a.value).toBe("L1 Green Glade Station");
    expect(a.score).toBeGreaterThan(0.6);

    const b = fuzzyMatch("Melodic Fields Station", PREFIXED);
    expect(b.value).toBe("L4 Melodic Fields Station");
    expect(b.score).toBeGreaterThan(0.6);
  });

  it("resolves a three-word station name against a Lagrange-PREFIXED entry", () => {
    // From the full multi-leg contract: the parser feeds the bare three-word
    // "Thundering Express Station" (Lagrange qualifier already stripped) and the
    // reference carries the "HUR-L3" prefix. Containment still bridges the gap.
    // (Generic synthetic prefix mirroring the real "HUR-L3" reference shape.)
    const PREFIXED = [
      "L1 Green Glade Station",
      "L3 Thundering Express Station",
      "L4 Melodic Fields Station",
      "Everus Harbor",
    ];
    const r = fuzzyMatch("Thundering Express Station", PREFIXED);
    expect(r.value).toBe("L3 Thundering Express Station");
    expect(r.score).toBeGreaterThan(0.6);
  });
});

// ---------------------------------------------------------------------------
// fuzzyMatch — no match / garbage / edge cases
// ---------------------------------------------------------------------------

describe("fuzzyMatch — no confident match", () => {
  it("returns null value below the threshold but still reports a score", () => {
    const r = fuzzyMatch("ZZQQXX", COMMODITIES);
    expect(r.value).toBeNull();
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThan(0.6);
  });

  it("returns null for an empty input", () => {
    expect(fuzzyMatch("", COMMODITIES)).toEqual({ value: null, score: 0 });
  });

  it("returns null for an empty candidate list", () => {
    expect(fuzzyMatch("Titanium", [])).toEqual({ value: null, score: 0 });
  });

  it("respects a custom threshold", () => {
    // With a very high threshold, a near-miss no longer qualifies.
    const strict = fuzzyMatch("Aluminun", COMMODITIES, { threshold: 0.99 });
    expect(strict.value).toBeNull();
    const loose = fuzzyMatch("Aluminun", COMMODITIES, { threshold: 0.5 });
    expect(loose.value).toBe("Aluminum");
  });

  it("never throws on garbage and skips empty candidates", () => {
    const r = fuzzyMatch("Quartz", ["", "  ", "Quartz"]);
    expect(r.value).toBe("Quartz");
  });
});

// ---------------------------------------------------------------------------
// matchTitleToMissions — title -> mission preselect (Part A)
// ---------------------------------------------------------------------------
// SANITIZED + SYNTHETIC mission titles modeled on the real near-duplicate pair
// (MIC-L2 Long Forest vs ARC-L1 Wide Forest). The matcher must CONFIDENTLY pick
// the right one when distinct, but refuse to preselect when two candidates are
// near-identical (no margin) or nothing clears the threshold.

describe("matchTitleToMissions", () => {
  const NEAR_DUPES = [
    "Senior | Medium Haul | from MIC-L2 Long Forest Station",
    "Senior | Medium Haul | from ARC-L1 Wide Forest Station",
  ];

  it("confidently picks the matching near-duplicate (MIC-L2, not ARC-L1)", () => {
    // OCR read (no pipes, slight wording drift) of the MIC-L2 contract.
    const r = matchTitleToMissions(
      "Senior Medium Haul from MIC-L2 Long Forest Station",
      NEAR_DUPES,
    );
    expect(r.index).toBe(0); // MIC-L2 Long Forest
    expect(r.confident).toBe(true);
    expect(r.score).toBeGreaterThan(0.6);
  });

  it("confidently picks ARC-L1 when that's the OCR'd title", () => {
    const r = matchTitleToMissions(
      "Senior Medium Haul from ARC-L1 Wide Forest Station",
      NEAR_DUPES,
    );
    expect(r.index).toBe(1); // ARC-L1 Wide Forest
    expect(r.confident).toBe(true);
  });

  it("is NOT confident when two candidate titles are truly identical (no margin)", () => {
    const identical = [
      "Senior | Medium Haul | from MIC-L2 Long Forest Station",
      "Senior | Medium Haul | from MIC-L2 Long Forest Station",
    ];
    const r = matchTitleToMissions(
      "Senior Medium Haul from MIC-L2 Long Forest Station",
      identical,
    );
    // A best candidate exists and scores high, but it can't beat its identical
    // twin by any margin -> ambiguous -> do NOT preselect.
    expect(r.score).toBeGreaterThan(0.6);
    expect(r.confident).toBe(false);
  });

  it("is NOT confident when nothing clears the threshold", () => {
    const r = matchTitleToMissions("Eliminate the bounty target", NEAR_DUPES);
    expect(r.confident).toBe(false);
    expect(r.score).toBeLessThan(0.6);
  });

  it("a single candidate is confident on a clear match (no runner-up)", () => {
    const r = matchTitleToMissions(
      "Senior Medium Haul from MIC-L2 Long Forest Station",
      ["Senior | Medium Haul | from MIC-L2 Long Forest Station"],
    );
    expect(r.index).toBe(0);
    expect(r.confident).toBe(true);
  });

  it("is defensive: null/empty title or empty candidates -> no match", () => {
    expect(matchTitleToMissions(null, NEAR_DUPES)).toEqual({
      index: -1,
      score: 0,
      confident: false,
    });
    expect(matchTitleToMissions("", NEAR_DUPES)).toEqual({
      index: -1,
      score: 0,
      confident: false,
    });
    expect(matchTitleToMissions("anything", [])).toEqual({
      index: -1,
      score: 0,
      confident: false,
    });
  });
});
