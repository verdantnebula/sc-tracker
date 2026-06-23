// Copy the BUNDLED tesseract.js OCR assets next to the built renderer.
// ---------------------------------------------------------------------------
// EXPERIMENTAL OCR fallback (Phase F). tesseract.js otherwise loads its worker,
// core WASM and language data from a jsDelivr CDN at runtime — unacceptable for
// an offline desktop app. This script copies those assets out of node_modules
// into `out/renderer/ocr/` so the renderer (ocrRunner.ts) can load them from a
// local sibling folder via a relative file:// URL. It runs AFTER electron-vite
// build (which clears out/) and is invoked by `npm run package:exe`, so the
// packaged app ships these files (the app is packaged unpacked — no asar — so a
// plain copied folder is directly readable at runtime).
//
// Assets copied:
//   - worker.min.js                       (tesseract.js worker entry)
//   - tesseract-core-simd-lstm.wasm + .js (the core WASM the worker loads)
//     plus the non-simd fallback core, so the worker can pick a variant.
//   - eng.traineddata.gz                  (tessdata_fast English; gz is fine —
//                                          tesseract.js gunzips it transparently)
//
// The heavy binaries are NOT committed to git (.gitignore covers out/ and the
// node_modules sources); this script regenerates them from the pinned deps. No
// network access — everything is copied from already-installed packages.
import { createRequire } from "node:module";
import {
  copyFileSync,
  mkdirSync,
  existsSync,
  statSync,
  readdirSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";

const require = createRequire(import.meta.url);

const outDir = join(process.cwd(), "out", "renderer", "ocr");
mkdirSync(outDir, { recursive: true });

function copyInto(srcPath, label) {
  if (!existsSync(srcPath)) {
    throw new Error(`[copy-ocr-assets] missing source (${label}): ${srcPath}`);
  }
  const dest = join(outDir, basename(srcPath));
  copyFileSync(srcPath, dest);
  const kb = (statSync(dest).size / 1024).toFixed(0);
  console.log(`[copy-ocr-assets] ${basename(dest)}  (${kb} KB)`);
}

// --- tesseract.js worker -----------------------------------------------------
const tjsDist = dirname(require.resolve("tesseract.js/package.json"));
copyInto(join(tjsDist, "dist", "worker.min.js"), "worker");

// --- tesseract.js-core WASM ---------------------------------------------------
// Ship ONLY the simd-lstm core variant (the smallest LSTM-capable, SIMD build)
// — Electron always has WASM + SIMD, so the non-SIMD core and the plain-LSTM
// core are never needed. tesseract.js v7 loads a core by fetching the variant's
// `*.wasm.js` glue (which streams the sibling `.wasm`), so we ship that PAIR.
// We drop the OTHER variants' large asm.js files, which is where the savings
// come from (see the size delta in the PR notes). ocrRunner.ts pins this exact
// variant via corePath so no other file is ever requested.
const coreDir = dirname(require.resolve("tesseract.js-core/package.json"));
for (const name of [
  "tesseract-core-simd-lstm.wasm.js",
  "tesseract-core-simd-lstm.wasm",
]) {
  copyInto(join(coreDir, name), `core:${name}`);
}

// --- eng.traineddata (tessdata_fast) ----------------------------------------
// @tesseract.js-data/eng ships gzipped traineddata under a version folder. Use
// the fast build (`4.0.0/eng.traineddata.gz`). tesseract.js auto-gunzips a .gz.
const engDir = dirname(require.resolve("@tesseract.js-data/eng/package.json"));
const fastGz = join(engDir, "4.0.0", "eng.traineddata.gz");
if (existsSync(fastGz)) {
  copyInto(fastGz, "lang:eng(fast,gz)");
} else {
  // Fallback: copy whatever traineddata variant the package provides.
  let copied = false;
  for (const entry of readdirSync(engDir)) {
    const candidate = join(engDir, entry, "eng.traineddata.gz");
    if (existsSync(candidate)) {
      copyInto(candidate, `lang:eng(${entry})`);
      copied = true;
      break;
    }
  }
  if (!copied) {
    throw new Error(
      "[copy-ocr-assets] no eng.traineddata(.gz) found in @tesseract.js-data/eng",
    );
  }
}

console.log(`[copy-ocr-assets] done -> ${outDir}`);
