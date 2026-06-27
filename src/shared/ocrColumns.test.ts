// ============================================================================
// ocrColumns.test.ts — PURE two-column isolation for full-screen contract OCR
// ----------------------------------------------------------------------------
// EVERY fixture is SANITIZED + SYNTHETIC. No real screenshots, no personal data.
// We hand-author OcrWord[] arrays (text + bbox + confidence) that mimic the word
// geometry tesseract.js v7 produces from the two-column mobiGlas contract screen:
//   - a HEADER BAND across the top (reward, title, deadline) above the columns,
//   - a DETAILS column on the LEFT (flavor prose at LOW x),
//   - a PRIMARY OBJECTIVES column on the RIGHT (the cargo, at HIGH x).
// isolateObjectivesColumn must KEEP the header + the right column and DROP the
// left flavor column, reconstructing clean top-to-bottom / left-to-right lines.
// ============================================================================

import { describe, expect, it } from "vitest";
import { isolateObjectivesColumn } from "./ocrColumns";
import type { OcrWord } from "@shared/types";

// Small helper: build an OcrWord on a given row (y) at a given x with a fixed
// glyph height/width so rows group cleanly and x-centers are unambiguous.
function w(
  text: string,
  x: number,
  y: number,
  width = 60,
  height = 24,
  confidence = 90,
): OcrWord {
  return { text, x0: x, y0: y, x1: x + width, y1: y + height, confidence };
}

// ---------------------------------------------------------------------------
// The canonical two-column Quartz contract (synthetic geometry).
//
// Layout (img is 1000 wide, 700 tall):
//   HEADER BAND (y 20..120, spans full width, ABOVE the columns):
//     "Reward"  "o"  "314,000"   and the title line.
//   COLUMN HEADER ROW (y ~ 160):
//     "DETAILS" at LEFT x=60     "PRIMARY" "OBJECTIVES" at RIGHT x=560..
//   BODY (y >= header row):
//     LEFT/DETAILS flavor (LOW x ~60..300): "containers", "smaller", "Chase",
//        "Hewitt" — must be DROPPED.
//     RIGHT/OBJECTIVES (HIGH x >= 560): the real objective + dropoffs — KEPT.
// ---------------------------------------------------------------------------
function quartzContractWords(): OcrWord[] {
  const colX = 560; // left edge of the PRIMARY OBJECTIVES column
  return [
    // --- HEADER BAND (above both columns) ---
    w("Reward", 60, 20),
    w("o", 760, 20, 20),
    w("314,000", 800, 20, 110),
    w("Senior", 60, 70),
    w("Medium", 130, 70),
    w("Haul", 210, 70, 50),

    // --- COLUMN HEADER ROW (y ~ 160) ---
    w("DETAILS", 60, 160, 110),
    w("PRIMARY", colX, 160, 110),
    w("OBJECTIVES", colX + 130, 160, 150),

    // --- BODY: LEFT / DETAILS flavor (LOW x) — must be DROPPED ---
    w("containers", 60, 210, 110),
    w("16", 190, 210, 30),
    w("SCU", 230, 210, 50),
    w("smaller", 60, 250, 90),
    w("Chase", 60, 470, 70),
    w("Hewitt", 140, 470, 70),

    // --- BODY: RIGHT / PRIMARY OBJECTIVES (HIGH x) — must be KEPT ---
    w("Deliver", colX, 210, 80),
    w("0/69", colX + 90, 210, 60),
    w("SCU", colX + 160, 210, 50),
    w("of", colX + 220, 210, 30),
    w("Quartz", colX + 260, 210, 80),
    // dropoff lines (each a "Freight elevator at <Station> above <body>" row)
    w("Seraphim", colX, 260, 110),
    w("Station", colX + 120, 260, 80),
    w("Baijini", colX, 300, 90),
    w("Point", colX + 100, 300, 60),
    w("Port", colX, 340, 50),
    w("Tressler", colX + 60, 340, 90),
    w("Everus", colX, 380, 80),
    w("Harbor", colX + 90, 380, 80),
  ];
}

describe("isolateObjectivesColumn", () => {
  it("keeps the header band + the objectives column and drops the DETAILS flavor", () => {
    const out = isolateObjectivesColumn(quartzContractWords(), 1000, 700);

    // (a) KEEPS objectives column content
    expect(out).toMatch(/Deliver/);
    expect(out).toMatch(/Quartz/);
    expect(out).toMatch(/Seraphim Station/);
    expect(out).toMatch(/Baijini Point/);
    expect(out).toMatch(/Port Tressler/);
    expect(out).toMatch(/Everus Harbor/);

    // (a) KEEPS the header (reward + title) — it is ABOVE the columns.
    expect(out).toMatch(/314,000/);
    expect(out).toMatch(/Senior Medium Haul/);

    // (b) DROPS the DETAILS flavor words (left column body)
    expect(out).not.toMatch(/containers/);
    expect(out).not.toMatch(/smaller/);
    expect(out).not.toMatch(/Chase/);
    expect(out).not.toMatch(/Hewitt/);

    // The DETAILS header word itself is in the body band on the left → dropped.
    expect(out).not.toMatch(/DETAILS/);
  });

  it("reconstructs 'Reward o 314,000' on one line (collapses the inter-column gap)", () => {
    const out = isolateObjectivesColumn(quartzContractWords(), 1000, 700);
    const rewardLine = out.split("\n").find((l) => /Reward/.test(l));
    expect(rewardLine).toBeDefined();
    expect(rewardLine).toMatch(/Reward o 314,000/);
  });

  it("reconstructs the Deliver objective on one line, left-to-right by x", () => {
    const out = isolateObjectivesColumn(quartzContractWords(), 1000, 700);
    const deliverLine = out.split("\n").find((l) => /Deliver/.test(l));
    expect(deliverLine).toBe("Deliver 0/69 SCU of Quartz");
  });

  // ---- Fallbacks ----

  it("falls back to an x-gutter split when no PRIMARY OBJECTIVES anchor is found", () => {
    // No header words at all — but a clear bimodal x-distribution: a left flavor
    // group and a right objectives group separated by a wide empty gutter.
    const words: OcrWord[] = [
      // left group (flavor) at x ~ 60..200
      w("containers", 60, 210, 110),
      w("smaller", 60, 250, 90),
      w("Chase", 60, 290, 70),
      // right group (objectives) at x ~ 560..
      w("Deliver", 560, 210, 80),
      w("Quartz", 700, 210, 80),
      w("Seraphim", 560, 260, 110),
      w("Station", 680, 260, 80),
    ];
    const out = isolateObjectivesColumn(words, 1000, 700);
    expect(out).toMatch(/Deliver/);
    expect(out).toMatch(/Quartz/);
    expect(out).toMatch(/Seraphim Station/);
    expect(out).not.toMatch(/containers/);
    expect(out).not.toMatch(/smaller/);
    expect(out).not.toMatch(/Chase/);
  });

  it("returns the full reconstructed text (never worse than today) when no anchor and no clear gutter", () => {
    // A single-column-ish layout: words all clustered at one x band, no anchor,
    // no bimodal split → passthrough (keep everything, reconstructed).
    const words: OcrWord[] = [
      w("Deliver", 60, 20, 80),
      w("0/69", 150, 20, 60),
      w("SCU", 220, 20, 50),
      w("of", 280, 20, 30),
      w("Quartz", 320, 20, 80),
    ];
    const out = isolateObjectivesColumn(words, 1000, 700);
    expect(out).toBe("Deliver 0/69 SCU of Quartz");
  });

  it("is total: empty input yields empty string, never throws", () => {
    expect(isolateObjectivesColumn([], 1000, 700)).toBe("");
  });

  it("tolerates a garbled PRIMARY OBJECTIVES header (fuzzy anchor match)", () => {
    // OCR sometimes garbles the header slightly: "PRIMARY OBJECTlVES".
    const words = quartzContractWords().map((word) =>
      word.text === "OBJECTIVES" ? { ...word, text: "OBJECTlVES" } : word,
    );
    const out = isolateObjectivesColumn(words, 1000, 700);
    expect(out).toMatch(/Deliver/);
    expect(out).toMatch(/Quartz/);
    expect(out).not.toMatch(/containers/);
  });
});
