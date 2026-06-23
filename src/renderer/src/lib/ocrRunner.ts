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
 * Run OCR on a PNG/JPEG data URL (from the main-process screen capture) and
 * parse the recognized text into contract fields. Delegates recognition to the
 * main process (window.api.recognizeOcr); the parse runs here.
 *
 * @param imageDataUrl a `data:image/png;base64,…` frame.
 */
export async function recognizeContract(
  imageDataUrl: string,
): Promise<OcrRunResult> {
  if (typeof imageDataUrl !== "string" || imageDataUrl.length === 0) {
    throw new Error("No image to recognize.");
  }

  const result = await window.api.recognizeOcr(imageDataUrl);
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
