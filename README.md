# SC Tracker

A local-first desktop companion for **Star Citizen** that reads the game's own
`Game.log` to track your **cargo hauling**, **salvage**, and **mining** — no account,
no telemetry, no game-memory access. The only network use is an optional check for
app updates; all game reference data ships bundled. It answers the questions the
game's UI doesn't: *"I'm holding a stack of multi-stop contracts and I just landed —
what do I unload here?"*, *"what's this salvage run worth split between us?"*, and
*"what mineral gives a 4,300 radar return, and where do I find it?"*

> Unofficial, fan-made tool. Not affiliated with or endorsed by Cloud Imperium
> Games. It only **reads** the log file the game already writes to disk; it never
> modifies game files, reads game memory, or intercepts network traffic.

## Install

1. Download **`SC-Tracker-Setup-<version>.exe`** from the
   [latest release](https://github.com/verdantnebula/sc-tracker/releases/latest).
2. Run it. The app isn't code-signed yet, so Windows SmartScreen may warn about an
   "unknown publisher" — choose **More info → Run anyway**.
3. On first launch, if Star Citizen isn't on the default drive, open the gear ⚙ menu
   and point the app at your `...\StarCitizen\LIVE` folder.

**Updates are built in.** The app checks GitHub on launch and downloads a newer
version in the background, but **never installs on its own** — you get a banner with a
**Restart & Update** button and decide when. You can also trigger a check anytime from
the gear ⚙ → **Check for updates**. Your data lives in `%APPDATA%\sc-cargo-tracker`
and is preserved across updates.

(Windows x64 only for now.)

## The three modes

Switch modes from the top-left wordmark (Cargo → Salvage → Mining); each carries its
own theme.

### 🚚 Cargo
- **Log-driven mission tracking.** Tails `Game.log` in real time and rebuilds each
  accepted hauling contract — giver, variant, grade, per-leg commodity / SCU /
  destination, completion state — straight from the log. Backfills from `logbackups\`
  on first run so past sessions aren't lost.
- **By-Dropoff aggregation** — the headline view: across all active contracts, it
  groups *remaining* cargo by destination terminal, so when you land it tells you
  exactly how many SCU of what to drop there — even when those SCU are spread across
  several contracts. Edit any leg inline, or open the full mission panel.
- **Route tab** — map + list views of the whole pickup → dropoff network, with
  **route optimization** (nearest-neighbour + 2-opt over each leg's in-game position,
  respecting your ship's capacity) producing an ordered itinerary.
- **Ship picker + hold-capacity bar** — pick your ship; see total SCU to move vs. your
  hold (trips / overflow).
- **Partial turn-ins + payout** — per-leg delivered SCU and an estimated reward.
  **History** keeps completed and abandoned hauls across sessions.

### 🔧 Salvage
- Track an active salvage run, tally stripped components, and compute a **sell & split**
  payout from bundled RMC / CMAT material prices. Keeps a history of past runs.

### ⛏ Mining
- Look up rocks by **mineral name** *or* **radar scan value** (e.g. "what gives a 4,300
  return?"), a rarity-coloured **rock-value table**, and a searchable **deposit
  reference** — with location-aware "minerals near you" derived from where you last
  were in-game.

### Across all modes
- **Always-on-top overlay** — a small, mode-aware card (next stop / mineral lookup)
  that floats over the game (use borderless/windowed). Pin it from the top bar.
- **Experimental OCR contract capture** (opt-in, gear ⚙) — reads the mobiGlas contract
  screen to recover SCU / commodity / destination / reward when the game doesn't log
  them. You review every field before anything is applied.
- **Current-location chip**, **custom LIVE-folder picker**, a **log-not-found banner**
  so a wrong path is never silent, and one-click **Collect Logs** diagnostics.
- **Resilience built in** — a single-instance lock stops two copies fighting over the
  database, and the SQLite store auto-recovers from corruption rather than refusing to
  start.
- **Offline by design** — all reference data (commodities, terminals, ships, salvage
  components, mineable rocks and deposits) ships as a bundled local snapshot. No
  runtime network call and no API token are needed to run the app.

## How it works (cargo log parsing)

Star Citizen writes a plain-text `Game.log` to its install folder
(`...\StarCitizen\LIVE\Game.log`), rotating the previous session into `logbackups\`.
The log holds far more than older community tooling assumed: the full hauling
contract is logged. The cargo parser is built around these event types (examples below
are **generic / sanitized** — no real player data):

- **Contract Accepted** — the mission id and human title.
  ```
  <SHUDEvent_OnNotification> "Contract Accepted:  Senior Rank - Medium Cargo Haul" MissionId:[<uuid>]
  ```
- **CLocalMissionPhaseMarker::CreateMarker** — present for *every* mission. Carries the
  giver/company, the **contract template** (which encodes commodity + variant +
  grade, e.g. `HaulCargo_AToB_RawOre_Iron_Stanton1_SupplyGrade`), the objective ids
  (`pickup_*` / `dropoff_*`), and 3D positions.
  ```
  <CLocalMissionPhaseMarker::CreateMarker> missionId[<uuid>] generator name[Covalex_Hauling]
      contract[HaulCargo_SingleToMulti3_Processed_Mixed_...] objectiveId[dropoff_<uuid>_0] position[x,y,z]
  ```
- **New Objective: Deliver …** — the per-leg commodity, SCU quantity, and human
  destination name. This is the richest line but it is **intermittently absent** (see
  caveat).
  ```
  <SHUDEvent_OnNotification> "New Objective: Deliver 0/13 SCU of Pressurized Ice to HDPC-Cassillo" ObjectiveId:[dropoff_<uuid>_0]
  ```
- **ObjectiveUpserted / ObjectiveComplete** — per-objective completion (pickup *and*
  dropoff) via a state enum (`MISSION_OBJECTIVE_STATE_COMPLETED`). This is how delivery
  progress is tracked, and it works even when the "New Objective" text never appeared.
- **EndMission CompletionType[…]** — the canonical terminal signal, machine-readable
  rather than notification text. Observed values: `CompletionType[Complete]` (finished)
  and `CompletionType[Abandon]` (abandoned).
  ```
  <EndMission> ... MissionId[<uuid>] CompletionType[Complete] Reason[Mission Ended]
  ```
- **Awarded N aUEC** — payout notification at completion. Its `MissionId` is always
  null, so the app attributes it to the mission whose `EndMission` fired within a short
  window just before.
- **RequestLocationInventory** — fires when you open a terminal/inventory; the app uses
  the latest live one to derive your **current location** (which also powers Mining's
  "near you").

Objective ids are **reused across missions**, so every leg is keyed on
`(missionId, objectiveId)` — never the objective id alone.

### Known caveat — intermittent "New Objective" suppression

The `New Objective: Deliver X SCU of <commodity> to <destination>` line is **not
emitted for every mission** — it's intermittently suppressed for reasons that are not
deterministic (the same contract template can succeed one minute and miss the next).
It affects all contract types and both major givers, and when it's missing the
SCU/destination text appears nowhere in the log for that mission's whole lifecycle.

What the app still recovers when this happens:

- **Commodity, variant, and grade** — always available from the contract template.
- **Completion / delivery progress** — always tracked via `ObjectiveUpserted`.
- **Destination name** — recoverable from the title route, or by reverse-looking-up the
  dropoff position against the bundled reference data.

The only field with no log fallback is the **SCU quantity** for suppressed missions —
which is where inline editing, the add/remove-leg editor, and the experimental OCR
capture come in. Payout, separately, is only reliable as a rough session/day total:
award notifications can be dropped on batch turn-ins, so per-mission payout is shown
with an "approximate" confidence cue, never as fact.

Log formats change between game patches, so the parser is defensive and self-tested
against the bundled fixture (`fixtures/`); re-verify after major patches.

## Build from source

Requires Node.js (developed on Node 22+). `better-sqlite3` is a native module shipped
as a prebuilt binary, so no compiler toolchain is needed for a normal install.

```bash
npm install
npm run dev          # electron-vite dev (HMR renderer + main reload)
```

### Native module ABI note (important)

`better-sqlite3` must be built for the runtime that loads it, and the app (Electron)
and the tests (Node) use **different** ABIs:

```bash
npm run rebuild:electron   # build the native binary for Electron — needed to RUN the app
npm run rebuild:node       # build it for Node — needed to run the TESTS
```

If `npm run dev` fails with a `NODE_MODULE_VERSION` mismatch, run
`npm run rebuild:electron`. If `npm test` fails with the same error, run
`npm run rebuild:node`.

### Test

```bash
npm run rebuild:node   # once, so the native module matches Node
npm test               # vitest — parser, watcher, store, recovery, settings, payout, OCR, E2E fixture
npm run typecheck      # tsc --noEmit for the node + web projects
```

The end-to-end test (`electron/realLogE2E.test.ts`) runs against a bundled, scrubbed
log fixture (`fixtures/e2e-sample.log`) and contains no personal data — it works on
any machine.

### Building installers

The official Windows installer (`SC-Tracker-Setup-<version>.exe`) is built in **CI**:
pushing a `vX.Y.Z` tag runs `.github/workflows/release.yml`, which packages the NSIS
installer with [electron-builder](https://www.electron.build/) and publishes it (plus
`latest.yml` + the `.blockmap` for delta updates) to the GitHub Release. electron-builder
is not run locally. For a quick **local, unsigned portable** build you can use:

```bash
npm run package:exe    # @electron/packager → a portable Windows x64 app in release/
```

### Updating reference data (optional, dev only)

The bundled snapshots (`electron/data/*.json`) only need refreshing when a game patch
changes the underlying data. Regeneration scripts (`fetch:reference` for cargo
commodity/terminal/ship data via a free UEX API token, plus the salvage and mining
fetchers) read from a gitignored `config.local.json` that is **never** bundled into the
packaged app. The shipped application makes **no** game-data network calls and contains
**no** token.

## Troubleshooting / collecting diagnostics

If something misbehaves and you want to report it, use the in-app gear ⚙ → **Collect
Logs**, or run the bundled collector directly (no Node or this repo required):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\collect-diagnostics.ps1
```

It writes a single human-readable report to your **Desktop**, named
`sc-tracker-diagnostics-<timestamp>.txt`, containing your OS/build/architecture, the
app/runtime versions, your `settings.json`, the **status** (size/timestamps only) of
`Game.log` and `logbackups\`, the database file status and any corruption-quarantine
history, the tail (~400 lines) of the app's own log (`logs\main.log`), and a listing of
the data folder.

Two privacy guarantees, both enforced by the collector:

- **Your Windows username is redacted to `<USER>`** in every path and value.
- **`Game.log` contents are never collected** — only the file's status. The log can
  contain gameplay / player data, so it's deliberately excluded.

The app keeps its own log at `%APPDATA%\sc-cargo-tracker\logs\main.log` (rotating,
capped at ~1.5 MB with one `main.log.1` backup). **Review the report before sharing**
and double-check nothing sensitive slipped through.

## Tech stack

Electron + Vite + React + TypeScript + better-sqlite3 (chokidar for log tailing,
tesseract.js for the OCR fallback, electron-updater for in-app updates). Packaged as an
NSIS installer with electron-builder in CI.

## License

[MIT](LICENSE) © 2026 verdantnebula.
