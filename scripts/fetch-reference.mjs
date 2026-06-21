// ============================================================================
// scripts/fetch-reference.mjs — DEV-ONLY UEX reference snapshot generator
// ----------------------------------------------------------------------------
// Regenerates electron/data/reference-data.json from the live UEX Corp API.
// Run this once per game patch (commodities/terminals change per patch):
//
//     npm run fetch:reference
//
// It reads the Bearer token from config.local.json (gitignored, dev-only — the
// token is NEVER shipped in the packaged app). The packaged app reads only the
// bundled snapshot this script writes; it never hits the network or the token.
//
// The UEX API 403s the default Node fetch User-Agent, so we send a browser-like
// one. Terminals are filtered to is_cargo_center and normalized to the exact
// shape the app's ReferenceData contract expects (mirrors mapCommodities /
// mapTerminals in electron/uexClient.ts).
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CONFIG_PATH = join(ROOT, "config.local.json");
const OUT_PATH = join(ROOT, "electron", "data", "reference-data.json");

const BASE_URL = "https://api.uexcorp.uk/2.0";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// --- token ------------------------------------------------------------------

function loadToken() {
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, "utf-8");
  } catch {
    console.error(
      `[fetch:reference] config.local.json not found at ${CONFIG_PATH}.\n` +
        `Copy config.example.json -> config.local.json and set a real uexToken.`,
    );
    process.exit(1);
  }
  const parsed = JSON.parse(raw);
  const token = parsed.uexToken;
  if (typeof token !== "string" || token.length === 0 || token === "REPLACE_ME") {
    console.error(
      "[fetch:reference] config.local.json has no valid uexToken. Aborting.",
    );
    process.exit(1);
  }
  return token;
}

// --- normalization (mirrors electron/uexClient.ts) --------------------------

function asArray(resp) {
  if (Array.isArray(resp)) return resp;
  if (resp && typeof resp === "object" && Array.isArray(resp.data))
    return resp.data;
  return [];
}

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const truthyFlag = (v) => v === 1 || v === true || v === "1";

function numOrNull(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)))
    return Number(v);
  return null;
}

function mapCommodities(resp) {
  return asArray(resp)
    .map((r) => ({ name: str(r.name), code: str(r.code), kind: str(r.kind) }))
    .filter((c) => c.name.length > 0);
}

function mapTerminals(resp) {
  return asArray(resp)
    .map((r) => ({
      name: str(r.name),
      displayname: str(r.displayname),
      nickname: str(r.nickname),
      isCargoCenter: truthyFlag(r.is_cargo_center),
      maxContainerSize: numOrNull(r.max_container_size),
    }))
    .filter((t) => t.name.length > 0)
    .filter((t) => t.isCargoCenter); // SPEC §2: dropdowns are cargo centers only
}

// --- fetch ------------------------------------------------------------------

async function fetchResource(path, token) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`UEX ${path} HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function main() {
  const token = loadToken();
  console.log("[fetch:reference] fetching /commodities and /terminals …");

  const [commRaw, termRaw] = await Promise.all([
    fetchResource("/commodities", token),
    fetchResource("/terminals", token),
  ]);

  const commodities = mapCommodities(commRaw);
  const terminals = mapTerminals(termRaw);

  if (commodities.length === 0 || terminals.length === 0) {
    throw new Error(
      `[fetch:reference] refusing to write empty snapshot ` +
        `(commodities=${commodities.length}, terminals=${terminals.length}).`,
    );
  }

  const snapshot = {
    fetchedAt: Date.now(),
    source: "uexcorp.space API 2.0",
    commodities,
    terminals,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");

  console.log(
    `[fetch:reference] wrote ${OUT_PATH}\n` +
      `  commodities: ${commodities.length}\n` +
      `  terminals (cargo centers): ${terminals.length}`,
  );
}

main().catch((err) => {
  console.error("[fetch:reference] failed:", err.message);
  process.exit(1);
});
