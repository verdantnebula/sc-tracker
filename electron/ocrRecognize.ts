// ============================================================================
// ocrRecognize.ts — MAIN-PROCESS tesseract.js OCR  (Phase F, EXPERIMENTAL)
// ----------------------------------------------------------------------------
// WHY THIS LIVES IN MAIN (not the renderer):
//   tesseract.js needs to (a) spawn a worker, (b) stream/require the core WASM,
//   and (c) read `eng.traineddata.gz` from disk. In the PACKAGED app the renderer
//   is sandboxed (`sandbox: true`) under a strict CSP (`default-src 'self'`), and
//   its document is loaded from inside `app.asar`. tesseract.js's browser worker
//   is created from a `blob:` URL that then `importScripts(file://…)` the worker
//   and `fetch(file://…)` the wasm/traineddata — cross-origin `file:` loads that
//   CSP + the opaque blob-worker origin block, and which can't be made reliable
//   without materially weakening the renderer's CSP. (See the PR notes.)
//
//   In the MAIN process (Node) none of that applies: tesseract.js v7 has a native
//   `worker_threads` worker and loads its core via `require(...)` and the language
//   data via `fs.readFile(...)`. Electron's fs/module patches are asar-aware, so
//   the tesseract runtime loads fine even though it sits inside `app.asar`. We only
//   have to hand tesseract a valid `langPath` (a directory holding
//   `eng.traineddata.gz`). We point it at the UNPACKED copy on disk
//   (`app.asar.unpacked/out/renderer/ocr`) so the read is a plain real-file read
//   with zero asar/CSP/sandbox involvement — the fully robust path.
//
// The captured frame (a PNG data URL from desktopCapturer) is passed renderer ->
// main, OCR'd here, and only the recognized TEXT + a confidence score go back. The
// image is consumed in memory and never written to disk or sent anywhere.
//
// tesseract.js is imported DYNAMICALLY (inside recognize) so the library only
// loads when the user actually triggers a capture — a normal launch with the
// experimental feature off pays nothing.
// ============================================================================

import { join } from "node:path";

/** Result of a main-process OCR pass: raw text + a 0..1 mean-word confidence. */
export interface OcrRecognizeResult {
  /** Raw recognized text (the renderer parses + fuzzy-matches it). */
  rawText: string;
  /** Tesseract's mean word confidence, normalized to 0..1 (diagnostic only). */
  confidence: number;
}

/**
 * Tesseract page-segmentation modes we use. The user crops to just the objective
 * lines + reward, so the input is a tight text region:
 *   - PSM 6  : "Assume a single uniform block of text" — the default for a crop
 *              of the objectives list; treats it as flowing lines (best general
 *              choice for the "Deliver … SCU …" block).
 *   - PSM 11 : "Sparse text — find as much text as possible in no particular
 *              order" — a fallback when the crop is loosely laid out / the block
 *              assumption hurts. Exposed so the renderer can retry.
 * (Values are tesseract's own PSM enum numbers, passed as strings to setParameters.)
 */
export type OcrPsm = "6" | "11";

/**
 * Character whitelist for the contract crop. The objectives/reward use only
 * letters, digits, spaces, and a small punctuation set ("/" for fractions like
 * "1/2", commas/periods in numbers, "-" and ":" in labels). Restricting the
 * alphabet stops tesseract inventing glyphs from the stylized font's flourishes.
 */
export const OCR_CHAR_WHITELIST =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 /,.-:";

/** The minimal slice of Electron `app` this module needs (so it's unit-testable). */
export interface AppPathInfo {
  /** True in the packaged app (assets are inside app.asar / unpacked beside it). */
  isPackaged: boolean;
  /** `process.resourcesPath` — the `resources/` dir that holds app.asar(.unpacked). */
  resourcesPath: string;
  /** `app.getAppPath()` — the project root (dev) or the app.asar path (packaged). */
  appPath: string;
}

/**
 * Resolve the directory holding the bundled OCR assets (`eng.traineddata.gz`,
 * the core wasm + glue, the worker script copied by scripts/copy-ocr-assets.mjs).
 *
 * PURE function (no Electron import) so it can be unit-tested with synthetic
 * inputs:
 *   - PACKAGED: `<resourcesPath>/app.asar.unpacked/out/renderer/ocr` — the assets
 *     unpacked from the asar by the `--asar.unpackDir="out/renderer/ocr"` rule in
 *     `package:exe`, i.e. REAL files on disk (no asar read, no CSP, no sandbox).
 *   - DEV / unpackaged: `<appPath>/out/renderer/ocr` — the copy electron-vite +
 *     copy:ocr drop next to the built renderer.
 *
 * Always uses forward-slash-safe `path.join`, so it is correct on Windows too.
 */
export function ocrAssetDir(info: AppPathInfo): string {
  if (info.isPackaged) {
    return join(
      info.resourcesPath,
      "app.asar.unpacked",
      "out",
      "renderer",
      "ocr",
    );
  }
  return join(info.appPath, "out", "renderer", "ocr");
}

/**
 * Run OCR on a PNG/JPEG data URL using a main-process tesseract.js worker, with
 * every asset resolved from the local disk directory `assetDir`. Always
 * terminates the worker (even on error) so a failed run can't leak it.
 *
 * The image is expected to be a PREPROCESSED crop (the renderer upscales,
 * grayscales, and binarizes the user's selection before sending it here), so we
 * tune tesseract for a tight text block: a page-segmentation mode (default PSM 6,
 * a single uniform block) and a character whitelist that stops the stylized font
 * producing junk glyphs.
 *
 * @param imageDataUrl a `data:image/png;base64,…` preprocessed crop.
 * @param assetDir     directory holding eng.traineddata.gz + the core/worker
 *                     assets (from {@link ocrAssetDir}).
 * @param psm          page-segmentation mode (default "6" = single uniform block).
 */
export async function recognize(
  imageDataUrl: string,
  assetDir: string,
  psm: OcrPsm = "6",
): Promise<OcrRecognizeResult> {
  if (typeof imageDataUrl !== "string" || imageDataUrl.length === 0) {
    throw new Error("No image to recognize.");
  }

  // Dynamic import keeps tesseract.js out of the main bundle's startup cost.
  const Tesseract = await import("tesseract.js");

  // In Node, tesseract.js:
  //   - spawns its own `worker_threads` worker (workerPath defaults to the
  //     bundled node worker-script; asar-aware so it loads from inside app.asar),
  //   - loads the core via `require('tesseract.js-core/…')` (asar-aware), so
  //     `corePath` is not consulted on Node — we omit it,
  //   - reads `<langPath>/eng.traineddata.gz` via `fs.readFile`. We point langPath
  //     at the UNPACKED real-file dir so the read never depends on asar.
  const worker = await Tesseract.createWorker("eng", undefined, {
    langPath: assetDir,
    // gzip: true is the default; eng.traineddata.gz is what copy-ocr-assets ships.
  });

  try {
    // Tune for a cropped text block. tessedit_pageseg_mode picks the segmentation
    // strategy; the whitelist constrains the alphabet to what a contract uses.
    // PSM enum values ARE the strings "6"/"11", so map straight onto the enum.
    const pageSegMode =
      psm === "11" ? Tesseract.PSM.SPARSE_TEXT : Tesseract.PSM.SINGLE_BLOCK;
    await worker.setParameters({
      tessedit_pageseg_mode: pageSegMode,
      tessedit_char_whitelist: OCR_CHAR_WHITELIST,
    });
    const { data } = await worker.recognize(imageDataUrl);
    const rawText = data.text ?? "";
    const confidence =
      typeof data.confidence === "number"
        ? Math.max(0, Math.min(1, data.confidence / 100))
        : 0;
    return { rawText, confidence };
  } finally {
    // Always free the worker — a leaked worker holds the wasm heap alive.
    await worker.terminate();
  }
}
