// ============================================================================
// SC Cargo Tracker — Shared Domain Types  (SPEC §5 + §4a)
// ----------------------------------------------------------------------------
// THIS FILE IS A CONTRACT. It is imported by main, preload, and renderer.
// Parallel phases (parser, store/UEX, UI) IMPORT from here — they MUST NOT edit
// these declarations. If a type genuinely needs to change, raise it as a shared
// contract change, do not fork it. Keep names stable.
// ============================================================================

// ---------------------------------------------------------------------------
// Enumerations / string-literal unions
// ---------------------------------------------------------------------------

/**
 * Mission shape, parsed from the contract template.
 *  - A_TO_B          : single pickup -> single dropoff
 *  - MULTI_TO_SINGLE : several pickups -> one dropoff
 *  - SINGLE_TO_MULTI : one pickup -> several dropoffs (the common haul)
 *  - MANUAL          : user-entered mission (no template)
 */
export type MissionVariant =
  | "A_TO_B"
  | "MULTI_TO_SINGLE"
  | "SINGLE_TO_MULTI"
  | "MANUAL";

/** Contract size tier from the template. UNKNOWN when not parseable. */
export type MissionGrade = "SMALL" | "SUPPLY" | "BULK" | "UNKNOWN";

/** Lifecycle state machine (SPEC §5, §7.4). */
export type MissionStatus =
  | "accepted"
  | "in_progress"
  | "complete"
  | "abandoned";

/** A leg is either picking cargo up or dropping it off. */
export type LegKind = "pickup" | "dropoff";

/**
 * Confidence in a mission's payout figure (SPEC §4a).
 *  - confirmed   : exactly one completion correlated to the award.
 *  - approximate : batch turn-in; award shared across N completions.
 *  - unknown     : award dropped / could not be attributed -> payout is null.
 */
export type PayoutConfidence = "confirmed" | "approximate" | "unknown";

/** Where a mission came from. 'log' = parsed from Game.log, 'manual' = user form. */
export type MissionSource = "log" | "manual";

/**
 * Which tracker the app is showing. The app ships two modes that share the same
 * window, log watcher and DB infrastructure but render different domains:
 *  - cargo   : the original SC Cargo Tracker (default).
 *  - salvage : the SC Salvage Tracker (Drake-Interplanetary themed).
 * Persisted in settings.json so the chosen mode survives a restart.
 */
export type AppMode = "cargo" | "salvage";

// ---------------------------------------------------------------------------
// Core records
// ---------------------------------------------------------------------------

/** A 3D world position as written to Game.log (zone-relative). */
export interface Position {
  x: number;
  y: number;
  z: number;
}

/**
 * One delivery objective within a mission.
 *
 * IDENTITY: `id` is the game objectiveId (e.g. `dropoff_<phase>_<n>` /
 * `pickup_<phase>_<n>`) when from log, or generated when manual. Because the
 * game REUSES objectiveId across missions, persistence must key on
 * (missionId, id) together — never `id` alone. (SPEC §2 🔑)
 */
export interface Leg {
  /** Game objectiveId, or generated id for manual entries. */
  id: string;
  /** Owning mission id. Composite DB key = (missionId, id). */
  missionId: string;
  kind: LegKind;
  /** Commodity name, normalized against UEX commodities where possible. */
  commodity: string;
  /** Total SCU for this leg. May be 0 when the log suppressed the amount. */
  scuTotal: number;
  /** SCU delivered so far. Default 0; set to scuTotal on objective-complete. */
  scuDelivered: number;
  /** Destination/source name, normalized vs UEX terminals. null when unknown. */
  location: string | null;
  /** Optional 3D world position from the marker event. */
  position?: Position;
  /** True once the objective is complete (ObjectiveUpserted / manual toggle). */
  completed: boolean;
}

/**
 * An accepted (or manually entered) cargo mission.
 *
 * IDENTITY: `id` is the game missionId (uuid) from log, or a generated id for
 * manual missions. Dedup on this across backfill + live (SPEC §7.2).
 */
export interface Mission {
  id: string;
  /** Human-readable title, e.g. "Senior Rank - Medium Cargo Haul". */
  title: string;
  /**
   * Contract giver / generator, e.g. "Covalex_Hauling", "Redwind_Hauling".
   * Do NOT hardcode an enum — givers are discovered from logs (SPEC §10 manifest).
   */
  giver: string;
  variant: MissionVariant;
  grade: MissionGrade;
  /** Raw contract template string (encodes variant+grade+commodities). */
  contractTemplate?: string;
  /** Contract definition id from the marker event. */
  contractDefinitionId?: string;
  status: MissionStatus;
  /** aUEC payout. null until correlated (or when attribution failed). */
  payout: number | null;
  payoutConfidence: PayoutConfidence;
  source: MissionSource;
  /** Epoch ms when accepted; null if unknown. */
  acceptedAt: number | null;
  /** Epoch ms when completed/ended; null if not terminal. */
  completedAt: number | null;
  /** Free-form user notes. Empty unless user-entered (SPEC §10 manifest). */
  notes: string;
  legs: Leg[];
}

// ---------------------------------------------------------------------------
// UEX reference data (cached locally; SPEC §2, §5 ReferenceCache)
// ---------------------------------------------------------------------------

export interface Commodity {
  name: string;
  code: string;
  kind: string;
}

export interface Terminal {
  name: string;
  displayname: string;
  nickname: string;
  /** UEX `is_cargo_center` — filter dropoff/pickup dropdowns on this. */
  isCargoCenter: boolean;
  /** UEX `max_container_size`; null when unspecified. */
  maxContainerSize: number | null;
}

export interface ReferenceData {
  commodities: Commodity[];
  terminals: Terminal[];
}

// ---------------------------------------------------------------------------
// Derived view models (computed; never persisted as source of truth)
// ---------------------------------------------------------------------------

/** A distinct commodity owed (or delivered) at a single dropoff location. */
export interface DropoffCommodity {
  commodity: string;
  /** Remaining SCU still to unload (summed across missions). */
  scuRemaining: number;
  /** SCU already delivered at this location for this commodity. */
  scuDelivered: number;
  /** All leg keys feeding this line — used to toggle them together. */
  legRefs: LegRef[];
}

/** A composite key referencing a single leg. */
export interface LegRef {
  missionId: string;
  legId: string;
}

/**
 * The By-Dropoff aggregation unit: one destination with combined commodities
 * across every active mission (SPEC §5 "By-dropoff view", design README §3).
 */
export interface DropoffGroup {
  location: string;
  /** Active (not fully delivered) commodity lines. */
  todo: DropoffCommodity[];
  /** Fully delivered commodity lines (for the delivered tray). */
  delivered: DropoffCommodity[];
  /** Sum of all remaining SCU at this stop. */
  scuRemaining: number;
  /** Total SCU (remaining + delivered) — denominator for the progress bar. */
  scuTotal: number;
  /** Percentage delivered, 0..100. */
  pctDelivered: number;
  /** True when nothing remains to unload here. */
  allDone: boolean;
  /** True when this is the player's current location (highlight). */
  isCurrentLocation: boolean;
}

/** Per-mission derived figures for the Mission List / detail panel. */
export interface MissionTotals {
  missionId: string;
  scuRemaining: number;
  scuTotal: number;
  legsDone: number;
  legsTotal: number;
  pctDelivered: number;
}

/** Lifetime / session totals for the History view header (SPEC §10 delta 1). */
export interface Totals {
  missionsCompleted: number;
  /** Total SCU hauled across completed missions (log-reported, approximate). */
  scuHauled: number;
  /** Total credits earned — always accrues, labeled approximate (SPEC §4a). */
  creditsEarned: number;
  /** Total fines, tracked separately (SPEC §4a). */
  finesTotal: number;
}

// ---------------------------------------------------------------------------
// Log watcher status (surfaced to the UI status strip)
// ---------------------------------------------------------------------------

export type LogConnectionState = "connected" | "disconnected" | "searching";

export interface LogStatus {
  state: LogConnectionState;
  /** Resolved Game.log path being watched, or null if not found. */
  logPath: string | null;
  /** UEX reference cache present/active. */
  uexActive: boolean;
}

/**
 * Current Game.log path resolution, surfaced to the settings UI. Lets the user
 * see exactly which folder is being watched and whether Game.log was found there.
 */
export interface LogPathInfo {
  /** The configured custom LIVE folder, or null when using the default. */
  liveFolder: string | null;
  /** The resolved Game.log path the watcher is (or would be) using. */
  gameLogPath: string;
  /** True when no custom folder is configured (watching the default LIVE path). */
  isDefault: boolean;
  /** True when gameLogPath exists on disk right now. */
  gameLogExists: boolean;
}

/**
 * Result of the native folder picker. On success the chosen folder was validated
 * (Game.log present) and saved, the watcher was retargeted, and `info` reflects
 * the new state. On failure nothing changed and `error` explains why.
 *  - canceled : the user dismissed the dialog (no error, no change).
 *  - ok       : a valid folder was chosen, saved, and the watcher restarted.
 *  - error    : the chosen folder had no Game.log (or the dialog failed).
 */
export interface PickLogFolderResult {
  outcome: "ok" | "canceled" | "error";
  /** Populated on "ok": the new resolved path info. */
  info?: LogPathInfo;
  /** Populated on "error": a human-readable message for an inline toast. */
  error?: string;
}

/** Backfill progress, driven by the real logbackups scan (design README §7). */
export interface BackfillProgress {
  /** 0..100. */
  progress: number;
  /** Rotating status sub-label, e.g. "Scanning logbackups…". */
  label: string;
  /** True once the scan has finished and the overlay may dismiss. */
  done: boolean;
}

// ---------------------------------------------------------------------------
// Manual entry payloads (renderer -> main; SPEC §4 secondary capture)
// ---------------------------------------------------------------------------

/** A leg as entered in the manual form (pre-persistence). */
export interface ManualLegInput {
  kind: LegKind;
  commodity: string;
  location: string | null;
  scuTotal: number;
}

/** A manual mission draft submitted from the form. */
export interface ManualMissionInput {
  title: string;
  giver: string;
  status: MissionStatus;
  legs: ManualLegInput[];
}

/** Partial mission edit (payout / notes / leg completion + field edits) from the detail panel. */
export interface MissionPatch {
  payout?: number | null;
  payoutConfidence?: PayoutConfidence;
  notes?: string;
  status?: MissionStatus;
  /**
   * Leg overrides, keyed by legId. Beyond completion/delivery, the user can fill
   * in fields the game's log suppressed (the intermittent objectiveDeclared bug):
   * commodity, scuTotal and location. Any field edit here is a USER action, so
   * the store stamps `manual_override` to protect it from historical replay.
   */
  legs?: Array<{
    legId: string;
    completed?: boolean;
    scuDelivered?: number;
    commodity?: string;
    scuTotal?: number;
    location?: string | null;
  }>;
  /**
   * New legs to INSERT into an existing mission (Mission Detail panel). Used for
   * Multi-to-Single / Single-to-Multi hauls — or log-suppressed missions — that
   * need extra pickups/dropoffs added after the fact. The store generates a
   * stable, unique leg id per entry and stamps `manual_override` (user action).
   * Field defaults: commodity '', scuTotal 0, location null, completed false.
   */
  addLegs?: Array<{
    kind: LegKind;
    commodity?: string;
    scuTotal?: number;
    location?: string | null;
  }>;
  /** Leg ids to DELETE from the mission (remove ✕ in the detail panel). */
  removeLegIds?: string[];
}

// ===========================================================================
// SALVAGE TRACKER (Phase 2 backend contract)
// ---------------------------------------------------------------------------
// These are ADDITIVE to the cargo contract above and frozen for the salvage UI
// phase to build against. The two trackers share the window/log/DB infra but
// keep their domain data on separate IPC channels + tables — they never share
// mutable state. Salvage is about stripping wrecks for materials (RMC / CMAT /
// construction) and components, then splitting the payout across a crew.
// ===========================================================================

/** Lifecycle of a salvage run. 'active' = in progress; terminal otherwise. */
export type SalvageRunStatus = "active" | "sold" | "abandoned";

/** The strippable component categories (mirror the reference component types). */
export type SalvageComponentType =
  | "powerplant"
  | "shield"
  | "quantumdrive"
  | "cooler"
  | "radar"
  | "weapon";

/**
 * A component pulled off a wreck during a run. `sold` gates whether its value
 * counts toward the run's component payout (unsold components are excluded).
 */
export interface StrippedComponent {
  id: string;
  runId: string;
  type: SalvageComponentType;
  /** Component model name, e.g. "AD4B Ballistic Gatling". */
  model: string;
  /** How many of this component were pulled. */
  qty: number;
  /** Sell price for ONE unit (aUEC). */
  sellPriceEach: number;
  /** True once sold — only sold components contribute to component value. */
  sold: boolean;
}

/**
 * A wreck claimed/processed within a run. Claim cost is the insurance/claim fee
 * paid to acquire the hull (a cost, tracked for the run ledger). Both the tier
 * and the resolved cost are nullable — not every wreck is claimed for credits.
 */
export interface Wreck {
  id: string;
  runId: string;
  shipName: string;
  /** Cost tier bucket from the reference data (e.g. 300/500/10000), or null. */
  claimCostTier: number | null;
  /** Resolved claim cost in aUEC, or null when not applicable. */
  claimCost: number | null;
  notes: string;
}

/**
 * One salvage run: a session of stripping wrecks for materials + components,
 * sold and split across a crew. `rmcScu` / `cmatScu` / `constructionScu` are the
 * raw material SCU yields entered for the run.
 */
export interface SalvageRun {
  id: string;
  /** Epoch ms when the run started. */
  startedAt: number;
  /** Epoch ms when sold/abandoned; null while active. */
  completedAt: number | null;
  status: SalvageRunStatus;
  /** Number of players splitting the payout (min 1). */
  crewSize: number;
  notes: string;
  /** Reclaimed Material Composite SCU. */
  rmcScu: number;
  /** Construction Material SCU. */
  cmatScu: number;
  /** Construction-piece SCU (sold separately; reserved for future pricing). */
  constructionScu: number;
  stripped: StrippedComponent[];
  wrecks: Wreck[];
}

/** Derived payout figures for a run (computed; never persisted as source). */
export interface SalvageTotals {
  /** rmcScu * materialPrices.rmcPerScu. */
  rmcValue: number;
  /** cmatScu * materialPrices.cmatPerScu. */
  cmatValue: number;
  /** Σ over SOLD stripped components of qty * sellPriceEach. */
  componentValue: number;
  /** rmcValue + cmatValue + componentValue. */
  totalValue: number;
  /** totalValue / max(1, crewSize). */
  valuePerPlayer: number;
}

// --- bundled salvage reference data (electron/data/salvage-reference.json) ---

/** A salvageable ship and its known loadout, grouped by claim cost tier. */
export interface SalvageReferenceShip {
  name: string;
  /** Cost-tier bucket (e.g. 300/500/10000/20000), or null when unknown. */
  costTier: number | null;
  /** Personal claim cost in aUEC, or null. */
  claimCost: number | null;
  /** Org-discounted claim cost in aUEC, or null. */
  claimCostOrg: number | null;
  /** CMAT yield (SCU), or null when not recorded. */
  cmat: number | null;
  /** Cargo capacity (SCU), or null when not recorded. */
  cargoScu: number | null;
  components: {
    powerplant: string | null;
    shield: string | null;
    quantumdrive: string | null;
    cooler: string | null;
    radar: string | null;
    weapons: string[];
  };
}

/** A reference component with its sell price (from the component sheets). */
export interface SalvageReferenceComponent {
  type: SalvageComponentType;
  model: string;
  /** Manufacturer class / weapon type, or null. */
  class: string | null;
  /** Component size, or null. */
  size: number | null;
  /** Grade letter (A/B/C/D), or null (weapons have none). */
  grade: string | null;
  /** Sell price in aUEC, or null when the worksheet had no price. */
  sellPrice: number | null;
}

/** A hauler ship usable to ferry salvage, with its cargo grid capacity. */
export interface SalvageHauler {
  name: string;
  /** Cargo grid capacity in SCU. */
  gridScu: number;
}

/** Default material sale rates (aUEC per SCU). */
export interface SalvageMaterialPrices {
  rmcPerScu: number;
  cmatPerScu: number;
}

/** The full bundled salvage reference snapshot served over salvage:reference. */
export interface SalvageReferenceData {
  ships: SalvageReferenceShip[];
  components: SalvageReferenceComponent[];
  materialPrices: SalvageMaterialPrices;
  haulers: SalvageHauler[];
}

// --- salvage mutation payloads (renderer -> main) ---------------------------

/** Fields to create a new run with. All optional except defaults are sensible. */
export interface SalvageRunInput {
  crewSize?: number;
  notes?: string;
  rmcScu?: number;
  cmatScu?: number;
  constructionScu?: number;
}

/** Partial edit of a run's material yields / crew / notes / status. */
export interface SalvageRunPatch {
  crewSize?: number;
  notes?: string;
  status?: SalvageRunStatus;
  rmcScu?: number;
  cmatScu?: number;
  constructionScu?: number;
}

/** A stripped component to add to a run (id/runId assigned by the store). */
export interface StrippedComponentInput {
  type: SalvageComponentType;
  model: string;
  qty: number;
  sellPriceEach: number;
  sold?: boolean;
}

/** Partial edit of a stripped component (qty / price / sold flag). */
export interface StrippedComponentPatch {
  type?: SalvageComponentType;
  model?: string;
  qty?: number;
  sellPriceEach?: number;
  sold?: boolean;
}
