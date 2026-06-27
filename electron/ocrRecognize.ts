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
import type { OcrWord } from "@shared/types";
import { isolateObjectivesColumn } from "@shared/ocrColumns";

/** Result of a main-process OCR pass: raw text + a 0..1 mean-word confidence. */
export interface OcrRecognizeResult {
  /** Raw recognized text (the renderer parses + fuzzy-matches it). */
  rawText: string;
  /** Tesseract's mean word confidence, normalized to 0..1 (diagnostic only). */
  confidence: number;
}

/**
 * Tesseract page-segmentation modes we use. The input may be a tight crop OR a
 * fuller capture where two screen columns sit side by side:
 *   - PSM 3  : "Fully automatic page segmentation" — the DEFAULT. It detects the
 *              column layout and reads each column as its own block, which stops
 *              the DETAILS column bleeding into the objective/location text (the
 *              root of the location over-capture bug). Paired with
 *              preserve_interword_spaces so column gaps survive as spaces.
 *   - PSM 6  : "Assume a single uniform block of text" — for a tight single-column
 *              crop of just the objectives list. Exposed so the renderer can retry.
 *   - PSM 11 : "Sparse text — find as much text as possible in no particular
 *              order" — a fallback when the crop is loosely laid out. Exposed for
 *              retry.
 * (Values are tesseract's own PSM enum numbers, passed as strings to setParameters.)
 */
export type OcrPsm = "3" | "6" | "11";

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
 * tune tesseract with a page-segmentation mode (default PSM 3, fully automatic —
 * detects the column layout so adjacent screen columns don't bleed together) and
 * a character whitelist that stops the stylized font producing junk glyphs.
 *
 * @param imageDataUrl a `data:image/png;base64,…` preprocessed crop.
 * @param assetDir     directory holding eng.traineddata.gz + the core/worker
 *                     assets (from {@link ocrAssetDir}).
 * @param psm          page-segmentation mode (default "3" = fully automatic).
 * @param isFullFrame  true when the image is a WHOLE-screen capture (no
 *                     calibrated region). On the full-frame path the screen has
 *                     TWO side-by-side columns (DETAILS + PRIMARY OBJECTIVES),
 *                     so we OCR with per-word boxes and isolate the objectives
 *                     column ({@link isolateObjectivesColumn}) before returning
 *                     the cleaned text. For a calibrated REGION the crop already
 *                     isolates one column, so isolation is a no-op (default
 *                     false keeps today's region behavior exactly).
 */
export async function recognize(
  imageDataUrl: string,
  assetDir: string,
  psm: OcrPsm = "3",
  isFullFrame = false,
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
    // Tune segmentation. tessedit_pageseg_mode picks the strategy; the whitelist
    // constrains the alphabet to what a contract uses. PSM enum values ARE the
    // strings "3"/"6"/"11", so map straight onto the enum (default AUTO = PSM 3).
    const pageSegMode =
      psm === "11"
        ? Tesseract.PSM.SPARSE_TEXT
        : psm === "6"
          ? Tesseract.PSM.SINGLE_BLOCK
          : Tesseract.PSM.AUTO;
    await worker.setParameters({
      tessedit_pageseg_mode: pageSegMode,
      tessedit_char_whitelist: OCR_CHAR_WHITELIST,
      // Keep inter-word spaces so a wide gutter between the objective and DETAILS
      // columns survives as whitespace instead of collapsing the two columns'
      // words together — reinforces PSM 3's column split against bleed.
      preserve_interword_spaces: "1",
    });
    // On the FULL-FRAME path we need per-word bounding boxes to geometrically
    // isolate the PRIMARY OBJECTIVES column from the side-by-side DETAILS column.
    // tesseract.js v7 only populates word geometry (under
    // data.blocks[].paragraphs[].lines[].words[]) when the recognize call OPTS IN
    // via the 3rd `output` arg `{ blocks: true }` — by default `data.blocks` is
    // null. For the region path we keep the default (text only) — no behavior or
    // cost change. (Verified empirically against tesseract.js 7.0.0.)
    const { data } = isFullFrame
      ? await worker.recognize(imageDataUrl, {}, { blocks: true })
      : await worker.recognize(imageDataUrl);
    const confidence =
      typeof data.confidence === "number"
        ? Math.max(0, Math.min(1, data.confidence / 100))
        : 0;

    // REGION path: return tesseract's flattened text unchanged (the crop already
    // isolated one column). FULL-FRAME path: rebuild clean text from just the
    // objectives column using the per-word boxes. Since fullFrameScale() === 1×,
    // the word boxes are already in source-image space — no inverse-scale needed.
    if (!isFullFrame) {
      return { rawText: data.text ?? "", confidence };
    }
    const words = wordsFromPage(data);
    const isolated = isolateObjectivesColumn(
      words,
      pageWidth(data, words),
      pageHeight(data, words),
    );
    // Defensive: if isolation produced nothing (no words/empty), fall back to
    // tesseract's flattened text so the full-frame path is never WORSE than the
    // region path's behavior.
    const rawText = isolated.length > 0 ? isolated : (data.text ?? "");
    return { rawText, confidence };
  } finally {
    // Always free the worker — a leaked worker holds the wasm heap alive.
    await worker.terminate();
  }
}

// ---------------------------------------------------------------------------
// Word-box extraction from a tesseract.js v7 Page (full-frame path only)
// ---------------------------------------------------------------------------
//
// tesseract.js is dynamically imported, so we describe ONLY the nested shape we
// read (blocks -> paragraphs -> lines -> words, each word a {text, bbox,
// confidence}) with a minimal structural type — no static tesseract import at
// module load. This shape was confirmed empirically against tesseract.js 7.0.0.

/** Minimal structural view of a tesseract Word (what we read). */
interface TessWordLike {
  text?: string;
  confidence?: number;
  bbox?: { x0?: number; y0?: number; x1?: number; y1?: number };
}
/** Minimal structural view of a tesseract Page (what we read). */
interface TessPageLike {
  text?: string;
  blocks?: Array<{
    paragraphs?: Array<{ lines?: Array<{ words?: TessWordLike[] }> }>;
  }> | null;
}

/**
 * Flatten a tesseract Page's nested block/paragraph/line tree into the flat
 * {@link OcrWord}[] the pure column-isolation pass consumes. Drops words with a
 * missing/empty text or an unusable bbox. PURE-ish (reads the page only).
 */
function wordsFromPage(page: TessPageLike): OcrWord[] {
  const out: OcrWord[] = [];
  for (const block of page.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const w of line.words ?? []) {
          const text = typeof w.text === "string" ? w.text.trim() : "";
          const b = w.bbox;
          if (
            text.length === 0 ||
            !b ||
            typeof b.x0 !== "number" ||
            typeof b.y0 !== "number" ||
            typeof b.x1 !== "number" ||
            typeof b.y1 !== "number"
          ) {
            continue;
          }
          out.push({
            text,
            x0: b.x0,
            y0: b.y0,
            x1: b.x1,
            y1: b.y1,
            confidence: typeof w.confidence === "number" ? w.confidence : 0,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Best-effort image WIDTH for the gutter heuristic. The Page doesn't expose the
 * source dimensions directly, so we use the rightmost word edge as a lower-bound
 * proxy (sufficient: the gutter test only needs a width scale). Falls back to a
 * sane default when there are no words.
 */
function pageWidth(_page: TessPageLike, words: OcrWord[]): number {
  let max = 0;
  for (const w of words) if (w.x1 > max) max = w.x1;
  return max > 0 ? max : 1;
}

/** Best-effort image HEIGHT (bottommost word edge); same rationale as width. */
function pageHeight(_page: TessPageLike, words: OcrWord[]): number {
  let max = 0;
  for (const w of words) if (w.y1 > max) max = w.y1;
  return max > 0 ? max : 1;
}
