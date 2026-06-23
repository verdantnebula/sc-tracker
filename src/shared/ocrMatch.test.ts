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
