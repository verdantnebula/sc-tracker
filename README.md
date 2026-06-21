# SC Cargo Tracker

A local desktop companion for **Star Citizen** cargo hauling that reconstructs your
hauling missions automatically by reading the game's own `Game.log` — no OCR, no
manual contract entry required, no game memory access. Built for the "I'm holding a
stack of multi-stop hauling contracts and I just landed — what do I unload here?"
problem.

> Unofficial, fan-made tool. Not affiliated with or endorsed by Cloud Imperium
> Games. It only **reads** the log file the game already writes to disk; it never
> modifies game files, reads game memory, or intercepts network traffic.

## What it does

- **Log-driven mission tracking.** Tails `StarCitizen\LIVE\Game.log` in real time and
  rebuilds each accepted hauling contract — giver, variant, grade, per-leg commodity /
  SCU / destination, completion state — straight from the log. On first run it also
  backfills from `logbackups\` so past sessions aren't lost.
- **By-Dropoff unload aggregation.** The headline view: across all your active
  contracts, it groups *remaining* cargo by destination terminal, so when you arrive
  somewhere it tells you exactly how many SCU of what to drop there — even if those
  SCU are spread across several different contracts.
- **Mission List.** Every active contract with its legs, status, and progress.
- **History.** Completed and abandoned hauls, kept across sessions (the log is
  rewritten each launch; the app persists to a local SQLite database).
- **Payouts (approximate).** Correlates `Awarded N aUEC` log lines to the mission that
  just completed and surfaces a session earnings figure. See the caveat below — payout
  is a rough stat, not a per-mission ledger.
- **Add / remove pickups & dropoffs when editing a mission.** Open a mission's detail
  panel to add *multiple* pickup or dropoff legs, or remove legs the log didn't capture
  correctly. Edits persist to the local database and flow straight into the by-dropoff
  aggregation — useful for the missions where the log suppressed the leg details (see
  "How it works").
- **Manual entry / override.** For the fields the log doesn't always provide (see
  "How it works"), you can fill in or correct SCU amounts and destinations by hand.
- **Custom LIVE-folder picker.** Point it at your install (`...\StarCitizen\LIVE`)
  from inside the app; it re-targets the watcher live.
- **Log-not-found banner.** If the log path is missing or wrong, the UI says so
  instead of silently showing nothing.
- **Resilience built in.** A single-instance lock prevents two copies fighting over the
  same database, and the SQLite store auto-recovers from corruption rather than refusing
  to start.
- **Offline reference data.** Commodity and terminal names for the manual-entry
  dropdowns and name normalization ship as a bundled local snapshot — no network call
  and no API token are needed to run the app.

## How it works

Star Citizen writes a plain-text `Game.log` to its install folder
(`...\StarCitizen\LIVE\Game.log`), rotating the previous session into `logbackups\`.
The log holds far more than older community tooling assumed: the full hauling
contract is logged. The parser is built around these event types (examples below are
**generic / sanitized** — no real player data):

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
- **Destination name** — recoverable by reverse-looking-up the dropoff position
  against the bundled reference data.

The only field with no log fallback is the **SCU quantity** for suppressed missions,
which is where manual entry and the add/remove-leg editor come in. Payout, separately,
is only reliable as a rough session/day total: award notifications can be dropped on
batch turn-ins, so per-mission payout is shown with an "approximate" confidence cue,
never as fact.

Log formats change between game patches, so the parser is defensive and self-tested
against the bundled fixture (`fixtures/`); re-verify after major patches.

## Build & Run

Requires Node.js (project developed on Node 22+). `better-sqlite3` is a native module
and is shipped as a prebuilt binary, so no compiler toolchain is needed for a normal
install.

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
`npm run rebuild:node`. (`npm run package:exe` rebuilds for Electron automatically.)

## Test

```bash
npm run rebuild:node   # once, so the native module matches Node
npm test               # vitest — parser, watcher, store, recovery, settings, multi-leg, E2E fixture
npm run typecheck      # tsc --noEmit for the node + web projects
```

The end-to-end test (`electron/realLogE2E.test.ts`) runs against a bundled, scrubbed
log fixture (`fixtures/e2e-sample.log`) and contains no personal data — it works on
any machine.

## Package

```bash
npm run package:exe    # rebuild native for Electron, build, package a Windows x64 app to release/
```

(`npm run dist` is an alias for `package:exe`.)

## Configuration

- **Point it at your game install.** Use the in-app folder picker to select your
  `...\StarCitizen\LIVE` folder. The app watches `Game.log` there (and backfills from
  `logbackups\`). No path is hardcoded.
- **Updating reference data (optional, dev only).** The bundled commodity/terminal
  snapshot (`electron/data/reference-data.json`) only needs refreshing when a game
  patch changes the data. To regenerate it you need a free UEX API token:
  1. Copy `config.example.json` to `config.local.json` and set your `uexToken`.
     `config.local.json` is gitignored and is **never** bundled into the packaged app.
  2. Run `npm run fetch:reference` to rewrite the snapshot, then rebuild.

  The shipped application makes **no** runtime network calls and contains **no** token.

## Troubleshooting / Collecting diagnostics

If something misbehaves and you want to report it, run the bundled diagnostics
collector and attach the file it produces. You don't need Node or this repo — just
the script.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\collect-diagnostics.ps1
```

It writes a single human-readable report to your **Desktop**, named
`sc-tracker-diagnostics-<timestamp>.txt`, containing:

- your OS / build / architecture, PowerShell version, and the current date/time;
- the app/runtime versions from `app-info.json` (written each time the app starts);
- your `settings.json` (the configured LIVE folder), pretty-printed;
- **status** of `Game.log` (configured path *and* the default install path) and a
  count of `logbackups\*.log` — *file size and timestamps only*;
- the database file status, its WAL/SHM sidecars, and any corruption-quarantine
  history (`*.corrupt-*` files);
- the tail (~400 lines) of the app's own log, `logs\main.log`;
- a listing of the app's data folder.

Two privacy guarantees, both enforced by the script:

- **Your Windows username is redacted to `<USER>`** in every path and value.
- **`Game.log` contents are never collected** — only the file's status. The log can
  contain gameplay / player data, so it's deliberately excluded.

The app keeps its own log at `%APPDATA%\sc-cargo-tracker\logs\main.log` (rotating,
capped at ~1.5 MB with one `main.log.1` backup). The report still shows
sanitized paths, so **review the file before sharing** and double-check nothing
sensitive slipped through.

## Tech Stack

Electron + Vite + React + TypeScript + better-sqlite3 (with chokidar for log tailing).

## License

[MIT](LICENSE) © 2026 verdantnebula.
