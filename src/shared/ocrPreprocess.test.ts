import { describe, it, expect } from "vitest";
import {
  mapSelectionToSource,
  cropRectFromRegion,
  fullFrameRect,
  normalizeScale,
  fullFrameScale,
  luminance,
  thresholdInvert,
  OCR_PREPROCESS_DEFAULTS,
  FULL_FRAME_TARGET_LONG_PX,
  FULL_FRAME_MAX_DIM_PX,
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

describe("fullFrameRect (region OPTIONAL -> whole-frame OCR)", () => {
  it("returns the whole frame as the rect for a 4K capture", () => {
    expect(fullFrameRect(3840, 2160)).toEqual({
      x: 0,
      y: 0,
      width: 3840,
      height: 2160,
    });
  });

  it("returns the whole frame for a small 720p capture", () => {
    expect(fullFrameRect(1280, 720)).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
    });
  });

  it("rounds fractional source dimensions to whole pixels", () => {
    expect(fullFrameRect(1280.4, 719.6)).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
    });
  });

  it("returns a zero rect for invalid / non-positive source dimensions", () => {
    const ZERO = { x: 0, y: 0, width: 0, height: 0 };
    expect(fullFrameRect(0, 1080)).toEqual(ZERO);
    expect(fullFrameRect(1920, -1)).toEqual(ZERO);
    expect(fullFrameRect(NaN, 1080)).toEqual(ZERO);
  });

  it("equals a 0..1 cropRectFromRegion (full-frame is the trivial whole-screen crop)", () => {
    const whole: ProportionalRegion = { x: 0, y: 0, w: 1, h: 1 };
    expect(fullFrameRect(1920, 1080)).toEqual(
      cropRectFromRegion(whole, 1920, 1080),
    );
  });
});

describe("fullFrameScale (BOUNDED upscale — Item 2)", () => {
  // Tesseract reads best near ~300 DPI; a low-res full frame benefits from a
  // bounded upscale toward a useful long-side resolution, WITHOUT blowing memory
  // on a 4K frame. The factor: target the long side at FULL_FRAME_TARGET_LONG_PX,
  // never below 1x (no downscale), and cap so neither dimension exceeds
  // FULL_FRAME_MAX_DIM_PX.

  it("keeps a 4K frame at ~1x (target < long side -> clamped up to 1)", () => {
    // 3840 long side already exceeds the ~2400 target, so no upscale; and the
    // max-dim cap keeps it from ever growing past FULL_FRAME_MAX_DIM_PX.
    const s = fullFrameScale(3840, 2160);
    expect(s).toBe(1);
  });

  it("never lets either dimension exceed the max-dim cap", () => {
    // Even a frame whose target would push it past the cap must be clamped so
    // 3840*s <= FULL_FRAME_MAX_DIM_PX.
    const s = fullFrameScale(3840, 2160);
    expect(3840 * s).toBeLessThanOrEqual(FULL_FRAME_MAX_DIM_PX);
    expect(2160 * s).toBeLessThanOrEqual(FULL_FRAME_MAX_DIM_PX);
  });

  it("upscales a 1080p full frame (>1x, within the cap)", () => {
    // 1920 long side, target ~2400 -> ~1.25x. Bounded: 1920*s <= cap.
    const s = fullFrameScale(1920, 1080);
    expect(s).toBeGreaterThan(1);
    expect(1920 * s).toBeLessThanOrEqual(FULL_FRAME_MAX_DIM_PX);
  });

  it("upscales a small 720p full frame more (~2x), still within the cap", () => {
    // 1280 long side, target ~2400 -> ~1.875x.
    const s = fullFrameScale(1280, 720);
    expect(s).toBeGreaterThan(1.5);
    expect(1280 * s).toBeLessThanOrEqual(FULL_FRAME_MAX_DIM_PX);
    // A small full frame now upscales, like (but capped differently from) a crop.
    expect(normalizeScale(1280, 720)).toBeGreaterThan(1);
  });

  it("NEVER downscales (factor >= 1) even for an over-cap input", () => {
    // A frame already wider than the cap must stay at 1x (not shrink) — losing
    // pixels only hurts OCR; the memory cost is the caller's existing concern.
    const s = fullFrameScale(5000, 3000);
    expect(s).toBe(1);
  });

  it("is defensive: non-finite / non-positive dims fall back to 1x", () => {
    expect(fullFrameScale(0, 1080)).toBe(1);
    expect(fullFrameScale(1920, -1)).toBe(1);
    expect(fullFrameScale(NaN, 1080)).toBe(1);
    expect(fullFrameScale()).toBe(1);
  });

  it("exposes the target + cap as documented constants", () => {
    expect(FULL_FRAME_TARGET_LONG_PX).toBeGreaterThanOrEqual(2200);
    expect(FULL_FRAME_TARGET_LONG_PX).toBeLessThanOrEqual(2600);
    expect(FULL_FRAME_MAX_DIM_PX).toBeCloseTo(4000, -2);
  });

  it("contrast: a small cropped region still upscales toward the target height", () => {
    // The cropped-region path is unchanged — a small crop upscales for legibility.
    expect(normalizeScale(800, 300)).toBe(4); // 1200/300 = 4, within maxScale
    expect(normalizeScale(800, 600)).toBeCloseTo(2, 5); // 1200/600 = 2x
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
