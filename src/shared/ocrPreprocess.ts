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
 *  - `scale`     : upscale factor applied to the crop before OCR (~3–4× makes the
 *                  small contract glyphs large enough for tesseract).
 *  - `threshold` : luminance cutoff for {@link thresholdInvert}.
 */
export const OCR_PREPROCESS_DEFAULTS = {
  scale: 3,
  threshold: 140,
} as const;
