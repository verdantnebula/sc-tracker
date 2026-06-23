// ============================================================================
// ocrRunner.ts — renderer-side tesseract.js wrapper  (Phase F, EXPERIMENTAL)
// ----------------------------------------------------------------------------
// Runs OCR on a captured screen frame using a tesseract.js worker, loading the
// core WASM, worker script and `eng.traineddata` from BUNDLED LOCAL paths — NOT
// a CDN — so the packaged app works fully offline (consistent with the app's
// no-runtime-network philosophy; tesseract.js otherwise defaults to a jsDelivr
// CDN). The assets are copied next to the built renderer at `out/renderer/ocr/`
// by scripts/copy-ocr-assets.mjs (run after electron-vite build + by package:exe).
//
// We import tesseract.js DYNAMICALLY (inside recognizeContract) so the ~60KB+
// library is only loaded when the user actually triggers a capture — the
// experimental feature costs nothing on a normal launch where it stays off.
//
// Defensive: any failure (missing assets, worker error, bad image) rejects with
// a readable Error; the dialog surfaces it. OCR output is text only — the image
// is consumed in-memory and never persisted.
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
 * Resolve the directory that holds the bundled OCR assets. The renderer is
 * loaded from `file://…/out/renderer/index.html` (packaged) or served by Vite
 * (dev). In both cases the assets live in a sibling `ocr/` folder relative to
 * the document, so a relative URL against the document base resolves correctly
 * without hard-coding an absolute filesystem path.
 */
function assetBase(): string {
  // new URL("ocr/", baseURI) yields the absolute file:// (or http:// in dev)
  // URL of the assets folder next to the current document.
  return new URL("ocr/", document.baseURI).href;
}

/**
 * Run OCR on a PNG/JPEG data URL (from the main-process screen capture) and
 * parse the recognized text into contract fields. Pure-ish: the only side effect
 * is creating + terminating a short-lived tesseract worker. Always terminates
 * the worker (even on error) so a failed run can't leak a worker.
 *
 * @param imageDataUrl a `data:image/png;base64,…` frame.
 */
export async function recognizeContract(
  imageDataUrl: string,
): Promise<OcrRunResult> {
  if (typeof imageDataUrl !== "string" || imageDataUrl.length === 0) {
    throw new Error("No image to recognize.");
  }

  // Dynamic import keeps tesseract.js out of the initial renderer bundle/cost.
  const Tesseract = await import("tesseract.js");
  const base = assetBase();

  // All asset paths point at the bundled local copies — never a CDN. corePath is
  // PINNED to the exact simd-lstm glue file we ship (copy-ocr-assets.mjs), so the
  // worker never tries to fetch a variant that isn't bundled. langPath is the
  // folder holding eng.traineddata.gz (tesseract.js gunzips it transparently).
  const worker = await Tesseract.createWorker("eng", undefined, {
    workerPath: `${base}worker.min.js`,
    corePath: `${base}tesseract-core-simd-lstm.wasm.js`,
    langPath: base,
    // No `logger` callback by default (keeps the console clean); progress is
    // coarse-grained and the capture is fast enough not to need a bar.
  });

  try {
    const { data } = await worker.recognize(imageDataUrl);
    const rawText = data.text ?? "";
    const confidence =
      typeof data.confidence === "number"
        ? Math.max(0, Math.min(1, data.confidence / 100))
        : 0;
    return {
      contract: parseContractOcr(rawText),
      rawText,
      confidence,
    };
  } finally {
    // Always free the worker — a leaked worker holds the wasm heap alive.
    await worker.terminate();
  }
}
