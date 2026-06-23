import { describe, it, expect } from "vitest";
import {
  mapSelectionToSource,
  luminance,
  thresholdInvert,
  OCR_PREPROCESS_DEFAULTS,
  type Rect,
} from "./ocrPreprocess";

describe("mapSelectionToSource", () => {
  // A 2000x1000 source displayed at half size (1000x500) -> scale 0.5. A box at
  // displayed (100,50)-(300,150) must map to source (200,100)-(600,300).
  it("maps a displayed selection back to source pixels at 2x scale", () => {
    const sel: Rect = { x: 100, y: 50, width: 200, height: 100 };
    const r = mapSelectionToSource(sel, 1000, 500, 2000, 1000);
    expect(r).toEqual({ x: 200, y: 100, width: 400, height: 200 });
  });

  it("is identity when displayed size equals source size", () => {
    const sel: Rect = { x: 10, y: 20, width: 30, height: 40 };
    const r = mapSelectionToSource(sel, 800, 600, 800, 600);
    expect(r).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });

  it("normalizes a drag made up-and-to-the-left (negative width/height)", () => {
    // User dragged from (300,150) to (100,50): stored as negative w/h.
    const sel: Rect = { x: 300, y: 150, width: -200, height: -100 };
    const r = mapSelectionToSource(sel, 1000, 500, 2000, 1000);
    expect(r).toEqual({ x: 200, y: 100, width: 400, height: 200 });
  });

  it("clamps a selection that overshoots the image edge", () => {
    // Displayed image is 1000x500 (2x). A box running off the right/bottom edge
    // must clamp to the source bounds, never read out-of-bounds pixels.
    const sel: Rect = { x: 900, y: 450, width: 400, height: 400 };
    const r = mapSelectionToSource(sel, 1000, 500, 2000, 1000);
    expect(r).toEqual({ x: 1800, y: 900, width: 200, height: 100 });
  });

  it("clamps a negative-origin selection to (0,0)", () => {
    const sel: Rect = { x: -50, y: -20, width: 200, height: 100 };
    const r = mapSelectionToSource(sel, 1000, 500, 2000, 1000);
    // left clamps to 0; right = (-50+200)/0.5 = 300 -> width 300.
    // top clamps to 0; bottom = (-20+100)/0.5 = 160 -> height 160.
    expect(r).toEqual({ x: 0, y: 0, width: 300, height: 160 });
  });

  it("returns a zero rect for a zero-area selection", () => {
    const sel: Rect = { x: 100, y: 100, width: 0, height: 0 };
    expect(mapSelectionToSource(sel, 1000, 500, 2000, 1000)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });

  it("returns a zero rect for invalid display/source dimensions", () => {
    const sel: Rect = { x: 0, y: 0, width: 10, height: 10 };
    expect(mapSelectionToSource(sel, 0, 500, 2000, 1000)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
    expect(mapSelectionToSource(sel, 1000, 500, 0, 1000)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
    expect(mapSelectionToSource(sel, NaN, 500, 2000, 1000)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });
});

describe("luminance", () => {
  it("is 0 for black and 255 for white", () => {
    expect(luminance(0, 0, 0)).toBe(0);
    expect(luminance(255, 255, 255)).toBeCloseTo(255, 5);
  });

  it("weights green most (Rec. 601)", () => {
    expect(luminance(0, 255, 0)).toBeGreaterThan(luminance(255, 0, 0));
    expect(luminance(255, 0, 0)).toBeGreaterThan(luminance(0, 0, 255));
  });

  it("gives bright cyan a high luminance (above default threshold)", () => {
    // Light cyan mobiGlas text, e.g. (120, 230, 240) -> should clear 140.
    expect(luminance(120, 230, 240)).toBeGreaterThan(
      OCR_PREPROCESS_DEFAULTS.threshold,
    );
  });

  it("gives a dark panel a low luminance (below default threshold)", () => {
    // Dark translucent panel, e.g. (20, 30, 35).
    expect(luminance(20, 30, 35)).toBeLessThan(
      OCR_PREPROCESS_DEFAULTS.threshold,
    );
  });
});

describe("thresholdInvert", () => {
  it("maps bright text to black (0) and dark background to white (255)", () => {
    expect(thresholdInvert(200)).toBe(0); // bright text -> black
    expect(thresholdInvert(40)).toBe(255); // dark panel -> white
  });

  it("treats a pixel exactly at the threshold as text (>=)", () => {
    expect(thresholdInvert(140, 140)).toBe(0);
    expect(thresholdInvert(139, 140)).toBe(255);
  });

  it("honors a custom threshold", () => {
    expect(thresholdInvert(100, 90)).toBe(0);
    expect(thresholdInvert(100, 110)).toBe(255);
  });

  it("end-to-end: cyan text binarizes to black, dark panel to white", () => {
    const text = thresholdInvert(luminance(120, 230, 240));
    const panel = thresholdInvert(luminance(20, 30, 35));
    expect(text).toBe(0);
    expect(panel).toBe(255);
  });
});
