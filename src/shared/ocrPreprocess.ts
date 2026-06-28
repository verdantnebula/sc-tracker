// ============================================================================
// ocrPreprocess.ts — PURE geometry + image-threshold helpers for OCR  (Phase F)
// ----------------------------------------------------------------------------
// EXPERIMENTAL. Supports the manual-crop OCR flow: the user drags a selection
// rectangle over a screenshot that is DISPLAYED scaled-to-fit in the dialog, then
// we must (a) map that on-screen selection back to ORIGINAL source-image pixels
// before cropping, and (b) binarize the cropped pixels (light cyan mobiGlas text
// on a dark translucent panel) into clean dark-on-light input tesseract prefers.
//
// Both pieces are PURE (numbers in, numbers out) and live here so they are fully
// unit-testable WITHOUT a DOM, a <canvas>, a real screenshot, or Electron. The
// renderer's canvas code calls these; the canvas itself (getImageData/putImageData)
// is the only non-pure part and stays in the component.
// ============================================================================

/** An axis-aligned rectangle in some pixel space (x,y = top-left). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Map a selection rectangle drawn in the DISPLAYED (scaled-to-fit) image space
 * back to the ORIGINAL source-image pixel space.
 *
 * The dialog shows the screenshot at some `displayWidth`×`displayHeight` (CSS
 * pixels) that is the source scaled by a single uniform factor to fit the box.
 * The user drags a box in that displayed space; to crop the real pixels we divide
 * by that factor. We derive the factor from the width ratio (uniform scale, so
 * height ratio is identical) and clamp the result to the source bounds so a drag
 * that overshoots the image edge can never read out-of-bounds pixels.
 *
 * PURE + defensive: non-finite / non-positive display dimensions yield a zero
 * rect (the caller treats a zero-area crop as "nothing selected").
 *
 * @param sel           selection rect in displayed (CSS-pixel) coordinates.
 * @param displayWidth  width the image is rendered at in the dialog (CSS px).
 * @param displayHeight height the image is rendered at in the dialog (CSS px).
 * @param sourceWidth   the screenshot's true pixel width.
 * @param sourceHeight  the screenshot's true pixel height.
 */
export function mapSelectionToSource(
  sel: Rect,
  displayWidth: number,
  displayHeight: number,
  sourceWidth: number,
  sourceHeight: number,
): Rect {
  const ZERO: Rect = { x: 0, y: 0, width: 0, height: 0 };
  if (
    !Number.isFinite(displayWidth) ||
    !Number.isFinite(displayHeight) ||
    displayWidth <= 0 ||
    displayHeight <= 0 ||
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0
  ) {
    return ZERO;
  }

  // Uniform scale source -> displayed (width and height ratios are equal for a
  // fit-to-box render; we use width and fall back to height defensively).
  const scaleX = displayWidth / sourceWidth;
  const scaleY = displayHeight / sourceHeight;

  // Normalize the selection so a drag in any direction has positive w/h.
  const left = Math.min(sel.x, sel.x + sel.width);
  const top = Math.min(sel.y, sel.y + sel.height);
  const right = Math.max(sel.x, sel.x + sel.width);
  const bottom = Math.max(sel.y, sel.y + sel.height);

  // Displayed -> source, then clamp to the source rectangle.
  const sx = clamp(left / scaleX, 0, sourceWidth);
  const sy = clamp(top / scaleY, 0, sourceHeight);
  const sRight = clamp(right / scaleX, 0, sourceWidth);
  const sBottom = clamp(bottom / scaleY, 0, sourceHeight);

  const x = Math.round(sx);
  const y = Math.round(sy);
  const width = Math.round(sRight - sx);
  const height = Math.round(sBottom - sy);

  if (width <= 0 || height <= 0) return ZERO;
  return { x, y, width, height };
}

/** Clamp `n` into [lo, hi]. */
function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/**
 * A proportional capture region (each field a fraction 0..1 of the screen). Kept
 * structurally local here so this pure module needs no cross-module value import;
 * it is the same shape as `OcrCaptureRegion` in @shared/types.
 */
export interface ProportionalRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Convert a PROPORTIONAL capture region (fractions 0..1 of the screen) into an
 * integer pixel {@link Rect} for an image of `srcW`×`srcH`, clamped to the image
 * bounds. This is how the Phase-2 one-button capture turns a per-user calibrated
 * region into the actual crop rectangle for the current screenshot, at whatever
 * resolution it was captured.
 *
 * PURE + total + defensive:
 *  - non-finite / non-positive source dimensions -> a zero rect;
 *  - each proportion is clamped to [0,1] first, so a slightly-out-of-range region
 *    (e.g. a calibration that ran to the very edge) never reads out of bounds;
 *  - the right/bottom edges are clamped to the image, then the rect is rounded to
 *    whole pixels. A degenerate (zero-area) result yields a zero rect, which the
 *    caller treats as "nothing to crop".
 *
 * @param region proportional region; fields are fractions 0..1 of the screen.
 * @param srcW   the screenshot's true pixel width.
 * @param srcH   the screenshot's true pixel height.
 */
export function cropRectFromRegion(
  region: ProportionalRegion,
  srcW: number,
  srcH: number,
): Rect {
  const ZERO: Rect = { x: 0, y: 0, width: 0, height: 0 };
  if (
    !Number.isFinite(srcW) ||
    !Number.isFinite(srcH) ||
    srcW <= 0 ||
    srcH <= 0 ||
    region === null ||
    typeof region !== "object" ||
    !Number.isFinite(region.x) ||
    !Number.isFinite(region.y) ||
    !Number.isFinite(region.w) ||
    !Number.isFinite(region.h)
  ) {
    return ZERO;
  }

  // Clamp the proportional box to [0,1], then derive its right/bottom fractions.
  const fx = clamp(region.x, 0, 1);
  const fy = clamp(region.y, 0, 1);
  const fRight = clamp(region.x + region.w, 0, 1);
  const fBottom = clamp(region.y + region.h, 0, 1);

  // Proportions -> pixels, clamped to the image, then rounded.
  const left = clamp(fx * srcW, 0, srcW);
  const top = clamp(fy * srcH, 0, srcH);
  const right = clamp(fRight * srcW, 0, srcW);
  const bottom = clamp(fBottom * srcH, 0, srcH);

  const x = Math.round(left);
  const y = Math.round(top);
  const width = Math.round(right - left);
  const height = Math.round(bottom - top);

  if (width <= 0 || height <= 0) return ZERO;
  return { x, y, width, height };
}

/**
 * Pick an upscale factor that brings a crop of `cropH` px tall to ~`targetHeightPx`
 * px tall, clamped to [1, maxScale]. Replaces the old FIXED 3× so the OCR input
 * size is consistent across resolutions: a tall 1440p crop is upscaled less, a
 * short 1080p crop more, both landing near a size tesseract reads well.
 *
 * This is the CROPPED-REGION path's scale: a small calibrated crop (just the
 * "Deliver … SCU …" lines) is upscaled for glyph legibility. The FULL-FRAME path
 * (no calibrated region) must NOT use this — a whole busy frame should never be
 * upscaled (it explodes memory and adds no legible detail); use
 * {@link fullFrameScale} there instead.
 *
 * PURE + total + defensive:
 *  - a non-finite / non-positive crop height, or a non-positive target, yields the
 *    neutral factor 1 (the crop is used as-is rather than throwing);
 *  - the raw ratio is clamped to [1, maxScale] so we never DOWNSCALE (which would
 *    lose glyph detail) and never blow memory on a tiny crop.
 *
 * @param _cropW          crop width in px (accepted for symmetry / future use).
 * @param cropH           crop height in px.
 * @param targetHeightPx  desired output height in px (default from defaults).
 * @param maxScale        upper bound on the factor (default from defaults).
 */
export function normalizeScale(
  _cropW: number,
  cropH: number,
  targetHeightPx: number = OCR_PREPROCESS_DEFAULTS.targetHeightPx,
  maxScale: number = OCR_PREPROCESS_DEFAULTS.maxScale,
): number {
  if (
    !Number.isFinite(cropH) ||
    cropH <= 0 ||
    !Number.isFinite(targetHeightPx) ||
    targetHeightPx <= 0 ||
    !Number.isFinite(maxScale) ||
    maxScale < 1
  ) {
    return 1;
  }
  const raw = targetHeightPx / cropH;
  return clamp(raw, 1, maxScale);
}

/**
 * The output rect for a FULL-FRAME OCR pass (no calibrated capture region): the
 * whole captured image, integer-pixel, clamped to a positive size. Used when
 * `ocrCaptureRegion` is null/undefined so OCR runs on the entire screen instead
 * of a crop. PURE + total + defensive: non-finite / non-positive source dims
 * yield a zero rect (the caller treats that as "nothing to OCR").
 *
 * @param srcW the captured frame's true pixel width.
 * @param srcH the captured frame's true pixel height.
 */
export function fullFrameRect(srcW: number, srcH: number): Rect {
  const ZERO: Rect = { x: 0, y: 0, width: 0, height: 0 };
  if (
    !Number.isFinite(srcW) ||
    !Number.isFinite(srcH) ||
    srcW <= 0 ||
    srcH <= 0
  ) {
    return ZERO;
  }
  return { x: 0, y: 0, width: Math.round(srcW), height: Math.round(srcH) };
}

/**
 * Target for a full frame's LONG side after upscale (px). Tesseract reads best
 * near ~300 DPI; for a typical mobiGlas capture, landing the long side around
 * ~2400px brings the small contract glyphs into a size it recognizes well. Set
 * inside the 2200–2600 window: high enough to help a 1080p/720p capture, low
 * enough that a 4K frame (already 3840 long) needs no upscale at all.
 */
export const FULL_FRAME_TARGET_LONG_PX = 2400;

/**
 * Hard cap on EITHER output dimension of a full-frame upscale (px) — the memory
 * guard. The derived factor is reduced if needed so neither width nor height
 * exceeds this, so a 4K (3840×2160) frame can never balloon toward the
 * cropped-region 3–4× (~11k×6k) and blow up the canvas. 4000 sits just above 4K's
 * long side, so a 4K frame stays ~1× while smaller frames still get their full
 * target upscale.
 */
export const FULL_FRAME_MAX_DIM_PX = 4000;

/**
 * The output scale for a FULL-FRAME OCR pass — a BOUNDED upscale (Item 2).
 *
 * Unlike the old fixed 1×, a LOW-RES full frame is now upscaled toward a useful
 * resolution (Tesseract reads best near ~300 DPI), while a high-res frame is left
 * essentially untouched and memory is never blown:
 *
 *   factor = clamp( FULL_FRAME_TARGET_LONG_PX / longSide,  1,  capScale )
 *   capScale = FULL_FRAME_MAX_DIM_PX / longSide   (so longSide*factor <= cap)
 *
 *  - min 1×  : NEVER downscale — losing pixels only hurts OCR.
 *  - max cap : neither dimension may exceed {@link FULL_FRAME_MAX_DIM_PX}, so a
 *              4K frame stays ~1× (no ~11k×6k blowup).
 *
 * Numbers, by design (long side drives it; aspect ratio is preserved):
 *  - 3840×2160 (4K)    -> target/long = 2400/3840 = 0.625 -> clamped UP to 1×
 *                         (cap 4000/3840 = 1.04 doesn't bind). Stays 3840×2160.
 *  - 1920×1080 (1080p) -> 2400/1920 = 1.25× -> 2400×1350 (cap 4000/1920=2.08 ok).
 *  - 1280×720  (720p)  -> 2400/1280 = 1.875× -> 2400×1350 (within cap).
 *  - 5000×3000 (over-cap input) -> target<long -> 1× (never downscale).
 *  - a small CROPPED region (e.g. 800×300) still goes through {@link normalizeScale}
 *    and upscales toward the target HEIGHT (3–4×) for legibility — unchanged.
 *
 * PURE + total + defensive: non-finite / non-positive dims fall back to 1×.
 *
 * @param srcW the captured frame's true pixel width.
 * @param srcH the captured frame's true pixel height.
 */
export function fullFrameScale(srcW?: number, srcH?: number): number {
  if (
    !Number.isFinite(srcW) ||
    !Number.isFinite(srcH) ||
    (srcW as number) <= 0 ||
    (srcH as number) <= 0
  ) {
    return 1;
  }
  const longSide = Math.max(srcW as number, srcH as number);
  const target = FULL_FRAME_TARGET_LONG_PX / longSide; // desired upscale
  const capScale = FULL_FRAME_MAX_DIM_PX / longSide; // max before exceeding cap
  // Never downscale (>=1); never exceed the max-dim cap. If the cap itself is
  // below 1 (an already-over-cap frame), clamp([1, <1]) collapses to 1 — we keep
  // 1× rather than shrinking, since downscaling hurts OCR.
  const upper = capScale < 1 ? 1 : capScale;
  return clamp(target, 1, upper);
}

/**
 * Perceptual luminance of an 8-bit RGB pixel, 0..255 (Rec. 601 weights). Used to
 * collapse a color crop to grayscale before thresholding. PURE.
 */
export function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Decide the output value for one grayscale pixel under a binarize+invert step
 * tuned for the mobiGlas UI: light text (high luminance) on a dark panel (low
 * luminance). tesseract reads DARK text on a LIGHT background best, so we INVERT:
 *   - luminance >= threshold  (the bright text)  -> 0   (black)
 *   - luminance <  threshold  (the dark panel)   -> 255 (white)
 * Returns the 0..255 value to write to all three channels. PURE.
 *
 * @param lum       pixel luminance 0..255 (e.g. from {@link luminance}).
 * @param threshold luminance cutoff (default 140 — above mid for cyan-on-dark).
 */
export function thresholdInvert(lum: number, threshold = 140): number {
  return lum >= threshold ? 0 : 255;
}

/**
 * Default preprocessing parameters for the crop. Centralized so the component and
 * any future tuning/tests share one source of truth.
 *  - `scale`          : legacy FIXED upscale factor (kept for reference; the
 *                       Phase-2 flow now derives the factor via {@link normalizeScale}
 *                       so OCR input height is consistent across resolutions).
 *  - `threshold`      : luminance cutoff for {@link thresholdInvert}.
 *  - `targetHeightPx` : the height (px) {@link normalizeScale} aims the crop at —
 *                       ~1200px makes the small contract glyphs large enough for
 *                       tesseract while staying bounded across resolutions.
 *  - `maxScale`       : upper bound on the derived upscale factor (avoids blowing
 *                       memory / over-upscaling a very short crop).
 */
export const OCR_PREPROCESS_DEFAULTS = {
  scale: 3,
  threshold: 140,
  targetHeightPx: 1200,
  maxScale: 4,
} as const;
