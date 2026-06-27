import { describe, it, expect } from "vitest";
import {
  mapSelectionToSource,
  cropRectFromRegion,
  normalizeScale,
  luminance,
  thresholdInvert,
  OCR_PREPROCESS_DEFAULTS,
  type Rect,
  type ProportionalRegion,
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

describe("cropRectFromRegion", () => {
  // The left 60% of a 1920x1080 screen (excludes the right-hand DETAILS column).
  it("converts a proportional region to an integer pixel rect", () => {
    const region: ProportionalRegion = { x: 0, y: 0, w: 0.6, h: 1 };
    const r = cropRectFromRegion(region, 1920, 1080);
    expect(r).toEqual({ x: 0, y: 0, width: 1152, height: 1080 });
  });

  it("handles an offset region (not anchored at the origin)", () => {
    // A box from 10%..70% horizontally, 20%..80% vertically.
    const region: ProportionalRegion = { x: 0.1, y: 0.2, w: 0.6, h: 0.6 };
    const r = cropRectFromRegion(region, 2000, 1000);
    expect(r).toEqual({ x: 200, y: 200, width: 1200, height: 600 });
  });

  it("rounds fractional pixel edges to whole pixels", () => {
    // 0.333 * 999 = 332.667 -> left 333; right = 0.833*999 = 832.167 -> width 499.
    const region: ProportionalRegion = { x: 1 / 3, y: 0, w: 0.5, h: 0.5 };
    const r = cropRectFromRegion(region, 999, 999);
    expect(r.x).toBe(333);
    expect(r.y).toBe(0);
    // right edge rounds independently of left, then width = right - left rounded.
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
    expect(Number.isInteger(r.x)).toBe(true);
    expect(Number.isInteger(r.width)).toBe(true);
  });

  it("clamps a region that runs past the right/bottom edge to the image bounds", () => {
    // x+w = 1.3 and y+h = 1.2 both overshoot; must clamp to the full image.
    const region: ProportionalRegion = { x: 0.5, y: 0.5, w: 0.8, h: 0.7 };
    const r = cropRectFromRegion(region, 1000, 1000);
    expect(r).toEqual({ x: 500, y: 500, width: 500, height: 500 });
  });

  it("clamps negative proportions up to 0", () => {
    const region: ProportionalRegion = { x: -0.1, y: -0.2, w: 0.4, h: 0.5 };
    const r = cropRectFromRegion(region, 1000, 1000);
    // left clamps to 0; right = clamp(-0.1+0.4)=0.3 -> 300; width 300.
    // top clamps to 0; bottom = clamp(-0.2+0.5)=0.3 -> 300; height 300.
    expect(r).toEqual({ x: 0, y: 0, width: 300, height: 300 });
  });

  it("is full-frame for a 0..1 region (the trivial 'whole screen' crop)", () => {
    const region: ProportionalRegion = { x: 0, y: 0, w: 1, h: 1 };
    expect(cropRectFromRegion(region, 1280, 720)).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
    });
  });

  it("returns a zero rect for a degenerate (zero-width/height) region", () => {
    expect(
      cropRectFromRegion({ x: 0.2, y: 0.2, w: 0, h: 0.5 }, 1000, 1000),
    ).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(
      cropRectFromRegion({ x: 0.2, y: 0.2, w: 0.5, h: 0 }, 1000, 1000),
    ).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("returns a zero rect for invalid source dimensions or non-finite fields", () => {
    const ok: ProportionalRegion = { x: 0, y: 0, w: 0.5, h: 0.5 };
    expect(cropRectFromRegion(ok, 0, 1000)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
    expect(cropRectFromRegion(ok, 1000, -5)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
    expect(
      cropRectFromRegion(
        { x: NaN, y: 0, w: 0.5, h: 0.5 } as ProportionalRegion,
        1000,
        1000,
      ),
    ).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe("normalizeScale", () => {
  it("upscales a short crop toward the target height", () => {
    // 300px tall, target 1200 -> factor 4 (within maxScale 4).
    expect(normalizeScale(800, 300, 1200, 4)).toBe(4);
  });

  it("clamps to maxScale when the crop is very short", () => {
    // 100px tall, target 1200 -> raw 12, clamped to maxScale 4.
    expect(normalizeScale(800, 100, 1200, 4)).toBe(4);
  });

  it("never downscales: a crop already >= target gets factor 1", () => {
    // 1500px tall, target 1200 -> raw 0.8, clamped UP to 1.
    expect(normalizeScale(2000, 1500, 1200, 4)).toBe(1);
  });

  it("derives a fractional factor between 1 and maxScale", () => {
    // 600px tall, target 1200 -> exactly 2x.
    expect(normalizeScale(800, 600, 1200, 4)).toBeCloseTo(2, 5);
    // 900px tall, target 1200 -> 1.333x.
    expect(normalizeScale(800, 900, 1200, 4)).toBeCloseTo(4 / 3, 5);
  });

  it("uses the centralized defaults when target/maxScale are omitted", () => {
    // With defaults targetHeightPx=1200, maxScale=4: a 400px crop -> 3x.
    expect(normalizeScale(800, 400)).toBeCloseTo(3, 5);
    expect(OCR_PREPROCESS_DEFAULTS.targetHeightPx).toBe(1200);
    expect(OCR_PREPROCESS_DEFAULTS.maxScale).toBe(4);
  });

  it("returns the neutral factor 1 for a non-positive / non-finite crop height", () => {
    expect(normalizeScale(800, 0, 1200, 4)).toBe(1);
    expect(normalizeScale(800, -50, 1200, 4)).toBe(1);
    expect(normalizeScale(800, NaN, 1200, 4)).toBe(1);
  });

  it("returns 1 for a non-positive target or sub-1 maxScale (defensive)", () => {
    expect(normalizeScale(800, 300, 0, 4)).toBe(1);
    expect(normalizeScale(800, 300, 1200, 0.5)).toBe(1);
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
