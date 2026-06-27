// ============================================================================
// ocrRunner.ts — renderer-side OCR entry point  (Phase F, EXPERIMENTAL)
// ----------------------------------------------------------------------------
// Runs OCR on a captured screen frame and parses the recognized text into
// contract fields. The heavy lifting (tesseract.js: spawning a worker, streaming
// the core WASM, reading eng.traineddata) happens in the MAIN process via
// `window.api.recognizeOcr` — NOT here. See electron/ocrRecognize.ts for why:
// in the packaged app the renderer is sandboxed under a strict CSP and is loaded
// from inside app.asar, so it cannot reliably spawn a tesseract worker or
// stream the wasm/traineddata; main (Node) loads those from disk unconstrained.
//
// This module is therefore thin: it asks main to OCR the frame, then runs the
// PURE parser (parseContractOcr) on the returned text. The image never leaves
// memory — main consumes the data URL for the OCR pass only and returns text.
// ============================================================================

import { parseContractOcr, type OcrContract } from "@shared/ocrParse";

/** Outcome of an OCR pass: the structured parse + the raw text + a 0..1 confidence. */
export interface OcrRunResult {
  contract: OcrContract;
  /** Raw OCR text (shown in the review dialog's "what OCR saw" disclosure). */
  rawText: string;
  /** Tesseract's mean word confidence, normalized to 0..1 (diagnostic only). */
  confidence: number;
}

/**
 * Run OCR on a PREPROCESSED crop PNG data URL (the dialog upscales + binarizes
 * the user's selection before calling this) and parse the recognized text into
 * contract fields. Delegates recognition to the main process
 * (window.api.recognizeOcr); the parse runs here.
 *
 * @param imageDataUrl a `data:image/png;base64,…` preprocessed crop.
 * @param psm          optional page-segmentation mode ("6" uniform block default,
 *                     "11" sparse) forwarded to the main-process tesseract pass.
 * @param isFullFrame  true for a WHOLE-screen capture (no calibrated region) —
 *                     forwarded to main so it isolates the PRIMARY OBJECTIVES
 *                     column from the side-by-side DETAILS column before
 *                     returning text. Default false (region/crop) is unchanged.
 */
export async function recognizeContract(
  imageDataUrl: string,
  psm?: "6" | "11",
  isFullFrame = false,
): Promise<OcrRunResult> {
  if (typeof imageDataUrl !== "string" || imageDataUrl.length === 0) {
    throw new Error("No image to recognize.");
  }

  const result = await window.api.recognizeOcr(imageDataUrl, psm, isFullFrame);
  if (result.outcome !== "ok") {
    throw new Error(result.error ?? "OCR failed.");
  }

  const rawText = result.rawText ?? "";
  const confidence =
    typeof result.confidence === "number"
      ? Math.max(0, Math.min(1, result.confidence))
      : 0;
  return {
    contract: parseContractOcr(rawText),
    rawText,
    confidence,
  };
}
