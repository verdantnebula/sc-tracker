// ============================================================================
// ocrPipeline.ts — the REUSABLE renderer OCR capture pipeline  (Phase 3)
// ----------------------------------------------------------------------------
// One function, runOcrPipeline(), that performs the full calibrated pass:
//   capture FULL screen (window.api.captureScreenForOcr)
//     -> crop to the saved proportional region (cropRectFromRegion)
//     -> preprocess in <canvas> (normalizeScale upscale, grayscale, threshold+
//        invert)  [the only non-pure step; lives in preprocessCrop]
//     -> recognize (window.api.recognizeOcr, runs tesseract.js in MAIN)
//     -> parse (parseContractOcr)
//     -> fuzzy-match each objective's commodity/location vs the bundled reference
//     -> ReviewObjective[]
//
// BOTH callers use this so the pipeline is defined once:
//   - OcrCaptureDialog (manual capture/review modal) — for its CALIBRATED path.
//   - AutoOcrCapture (Phase 3 auto host) — runs it headless on an accept signal.
//
// The dialog keeps its own UNCALIBRATED draw-a-box flow (it needs the live DOM
// selection); only the shared calibrated pipeline is extracted here. Everything
// is guarded by the caller — this function throws on hard failures (no capture,
// degenerate region, OCR error) and the callers turn that into UI / a silent
// no-op as appropriate.
// ============================================================================

import type { ReferenceData, OcrCaptureRegion } from "@shared/types";
import { fuzzyMatch } from "@shared/ocrMatch";
import {
  cropRectFromRegion,
  fullFrameRect,
  normalizeScale,
  fullFrameScale,
  luminance,
  thresholdInvert,
  OCR_PREPROCESS_DEFAULTS,
  type Rect,
} from "@shared/ocrPreprocess";
import type { OcrObjective } from "@shared/ocrParse";
import { recognizeContract } from "./ocrRunner";

/** A reviewable objective row: OCR'd + fuzzy-matched values, all editable. */
export interface ReviewObjective {
  kind: "pickup" | "dropoff";
  scu: number | null;
  commodity: string;
  /** 0..1 confidence of the commodity fuzzy match (0 when user-edited/no match). */
  commodityScore: number;
  location: string;
  locationScore: number;
}

/** The full result of one calibrated OCR pass. */
export interface OcrPipelineResult {
  /** Fuzzy-matched objectives (empty when nothing parsed). */
  objectives: ReviewObjective[];
  /** Parsed contract reward in aUEC, or null when not detected. */
  reward: number | null;
  /**
   * The OCR'd contract title (cleaned), or null when no haul-title line was
   * found. Used by the review dialog to pre-select the target mission and to
   * show the user what title was read. See [[ocrMatch]] matchTitleToMissions.
   */
  title: string | null;
  /** Tesseract's mean confidence, 0..1 (diagnostic). */
  confidence: number;
  /** Raw OCR text (shown in the dialog's disclosure). */
  rawText: string;
}

/**
 * Run the OCR pipeline end-to-end and return the matched objectives.
 *
 * REGION IS OPTIONAL. When `region` is null/undefined the pass OCRs the FULL
 * captured frame (no crop); when a region is set it crops to it exactly as the
 * calibrated path always did. Calibration is now an accuracy booster, not a
 * prerequisite.
 *
 * Throws (for the caller to handle) on: a failed/empty screen capture, an
 * undecodable screenshot, a degenerate rect (a SET region maps to zero pixels, or
 * a zero-size frame), or an OCR error. Returns an EMPTY `objectives` array when
 * the pass simply parsed nothing — the auto path treats that as "discard", the
 * dialog as "offer re-draw".
 *
 * @param region    the user's calibrated proportional capture region, or null to
 *                  OCR the whole frame.
 * @param reference bundled reference (fuzzy-match candidates).
 */
export async function runOcrPipeline(
  region: OcrCaptureRegion | null,
  reference: ReferenceData,
): Promise<OcrPipelineResult> {
  // 1. CAPTURE the full screen (main grabs the primary display as a PNG).
  const cap = await window.api.captureScreenForOcr();
  if (cap.outcome !== "ok" || !cap.dataUrl) {
    throw new Error(cap.error ?? "Could not capture the screen.");
  }

  // Decode into an offscreen <img> so the crop canvas has a pixel source.
  const img = await loadImage(cap.dataUrl);

  // 2. Determine the OCR rect. A SET region crops (proportions -> pixels, clamped
  // to bounds); a NULL region uses the whole frame (full-screen OCR by default).
  // preprocessCrop reads the right scale per case (full-frame is capped at 1×).
  const srcRect = region
    ? cropRectFromRegion(region, img.naturalWidth, img.naturalHeight)
    : fullFrameRect(img.naturalWidth, img.naturalHeight);
  if (srcRect.width <= 0 || srcRect.height <= 0) {
    throw new Error(
      region
        ? "The saved capture region was empty."
        : "The captured screen was empty.",
    );
  }

  // 3. PREPROCESS + 4. RECOGNIZE + 5. PARSE (recognizeContract does 4+5).
  // `isFullFrame` (region == null) tells preprocessCrop to cap the scale at 1×
  // (memory guard) AND tells main to isolate the PRIMARY OBJECTIVES column from
  // the side-by-side DETAILS column (a full-screen capture has both; a calibrated
  // crop already isolated one column, so the flag stays false there).
  const isFullFrame = region == null;
  const processed = preprocessCrop(img, srcRect, isFullFrame);
  const result = await recognizeContract(processed, "6", isFullFrame);

  // 6. FUZZY-MATCH each objective vs the bundled reference.
  const objectives = reviewObjectivesFrom(
    result.contract.objectives,
    reference,
  );

  return {
    objectives,
    reward: result.contract.reward,
    title: result.contract.title,
    confidence: result.confidence,
    rawText: result.rawText,
  };
}

/**
 * Fuzzy-match each parsed objective's commodity/location against the bundled
 * reference. The raw OCR span is the fallback when no candidate clears the
 * threshold, so a downstream reviewer still sees what OCR read.
 */
export function reviewObjectivesFrom(
  parsed: OcrObjective[],
  reference: ReferenceData,
): ReviewObjective[] {
  const commodityNames = reference.commodities.map((c) => c.name);
  const locationNames = reference.terminals
    .map((t) => t.displayname || t.name)
    .filter(Boolean);
  return parsed.map((o) => {
    const cm = fuzzyMatch(o.commodity, commodityNames);
    const lm = fuzzyMatch(o.location, locationNames);
    return {
      kind: o.kind,
      scu: o.scu,
      commodity: cm.value ?? o.commodity,
      commodityScore: cm.value ? cm.score : 0,
      location: lm.value ?? o.location,
      locationScore: lm.value ? lm.score : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Image helpers — capture decode + canvas crop/preprocess (renderer-only)
// ---------------------------------------------------------------------------

/** Decode a PNG data URL into an <img> (resolves once it has real dimensions). */
export function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode the screenshot."));
    img.src = dataUrl;
  });
}

/**
 * Crop `srcRect` (source pixels) from `img` and preprocess it for OCR:
 *   1. draw the crop scaled by the appropriate factor,
 *   2. grayscale via perceptual luminance,
 *   3. threshold + invert -> dark text on light (what tesseract reads best).
 * Returns a PNG data URL. The only non-pure step (canvas getImageData) lives
 * here; the geometry/per-pixel math is the pure normalizeScale/fullFrameScale/
 * luminance/thresholdInvert. Throws a readable error if a 2D context can't be
 * obtained.
 *
 * SCALE DECISION (memory guard):
 *  - CROPPED region (`isFullFrame` false): a small crop is upscaled toward the
 *    target height via normalizeScale (3–4×) so the glyphs are legible.
 *  - FULL FRAME (`isFullFrame` true): capped at fullFrameScale() === 1×, so a 4K
 *    frame stays 4K instead of exploding to ~11k×6k. Never downscaled below 1×.
 *
 * @param isFullFrame true when `srcRect` is the WHOLE captured frame (no region).
 */
export function preprocessCrop(
  img: HTMLImageElement,
  srcRect: Rect,
  isFullFrame = false,
): string {
  const { threshold } = OCR_PREPROCESS_DEFAULTS;
  const scale = isFullFrame
    ? fullFrameScale(srcRect.width, srcRect.height)
    : normalizeScale(srcRect.width, srcRect.height);
  const outW = Math.max(1, Math.round(srcRect.width * scale));
  const outH = Math.max(1, Math.round(srcRect.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D context unavailable for preprocessing.");

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    img,
    srcRect.x,
    srcRect.y,
    srcRect.width,
    srcRect.height,
    0,
    0,
    outW,
    outH,
  );

  const image = ctx.getImageData(0, 0, outW, outH);
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    const lum = luminance(px[i], px[i + 1], px[i + 2]);
    const v = thresholdInvert(lum, threshold);
    px[i] = v;
    px[i + 1] = v;
    px[i + 2] = v;
    px[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);

  return canvas.toDataURL("image/png");
}
