// ============================================================================
// diagnosticsReport.ts — build the "Collect Logs" issue-report bundle
// ----------------------------------------------------------------------------
// The in-app "Collect Logs" action lets a non-technical user describe a problem
// and drops a timestamped report folder + zip on their Desktop. The report lets
// the maintainer compare WHAT THE GAME LOGGED (sanitized Game.log mission-event
// extract) vs WHAT THE APP CAPTURED (the mission store's state) — the two sides
// of every "I accepted N missions, only M showed up" bug.
//
// This module is split into:
//   - PURE builders (testable, no I/O): report.txt header text, captured-state
//     text from a Mission[] / SalvageRun[], and the sanitized Game.log extract.
//   - extractMissionEventLines(): filters raw log text to mission-lifecycle lines
//     and caps the count, then redacts each (the redactor is injected).
//
// A reporting tool must NEVER crash the app, so the public builders tolerate
// missing/garbage input. The impure folder/zip orchestration lives in main.ts.
// ============================================================================

import type { Mission, SalvageRun } from "@shared/types";

// ---------------------------------------------------------------------------
// Game.log mission-event extraction
// ---------------------------------------------------------------------------

/**
 * Signatures that mark a Game.log line as part of the mission lifecycle. A line
 * is kept for the extract iff it contains ANY of these (case-sensitive — the log
 * uses these exact tokens). KEEP commodity/SCU/location/missionId/timestamp text
 * on these lines; identity is stripped separately by the injected redactor.
 */
export const MISSION_EVENT_SIGNATURES: readonly string[] = [
  "Contract Accepted",
  "CLocalMissionPhaseMarker::CreateMarker",
  "New Objective",
  "ObjectiveUpserted",
  "ObjectiveComplete",
  "EndMission",
  "MissionEnded",
  "Awarded",
  "Fined",
  "RequestLocationInventory",
  "CommsNotifications",
  "ObjectiveTokenDef",
  "CContractGenerator",
  "MissionStartCommsNotification",
];

/** Default cap on extracted lines (keep the LAST N — most recent activity). */
export const DEFAULT_MAX_EXTRACT_LINES = 2000;

/** True if a line is a mission-lifecycle line worth keeping in the extract. */
export function isMissionEventLine(line: string): boolean {
  if (typeof line !== "string" || line.length === 0) return false;
  for (const sig of MISSION_EVENT_SIGNATURES) {
    if (line.includes(sig)) return true;
  }
  return false;
}

/**
 * Filter raw log text to mission-lifecycle lines, cap to the last `maxLines`,
 * and apply `redact` to each kept line. Pure (redactor injected). Returns the
 * kept lines (already redacted), newest-biased (the tail when over the cap).
 */
export function extractMissionEventLines(
  logText: string,
  redact: (s: string) => string,
  maxLines: number = DEFAULT_MAX_EXTRACT_LINES,
): string[] {
  if (typeof logText !== "string" || logText.length === 0) return [];
  const kept: string[] = [];
  for (const line of logText.split(/\r?\n/)) {
    if (isMissionEventLine(line)) kept.push(line);
  }
  const capped =
    maxLines > 0 && kept.length > maxLines
      ? kept.slice(kept.length - maxLines)
      : kept;
  return capped.map((l) => {
    try {
      return redact(l);
    } catch {
      return "";
    }
  });
}

// ---------------------------------------------------------------------------
// captured-state.txt — what the APP stored (the "what the app captured" side)
// ---------------------------------------------------------------------------

/**
 * Render the mission store's current state to a human-readable block: per-mission
 * summary (id, title, giver, variant/grade, status, source, session is not on the
 * Mission view so we omit it, #legs + a one-line-per-leg summary) plus counts.
 * Mission ids/commodity/SCU/location are KEPT (the maintainer needs them); no
 * player identity is present in stored state, so no redaction is required here,
 * but the caller still runs the whole report dir through a redaction grep.
 *
 * Pure + defensive: a malformed mission/leg degrades to a "(unknown)" field.
 */
export function buildCapturedStateText(missions: Mission[]): string {
  const list = Array.isArray(missions) ? missions : [];
  const lines: string[] = [];

  lines.push("WHAT THE APP CAPTURED (mission store state)");
  lines.push("=".repeat(70));
  lines.push("");

  // Counts by status — the headline for an "N accepted, M stored" bug.
  const byStatus = new Map<string, number>();
  for (const m of list) {
    const s = safeStr(m?.status, "(unknown)");
    byStatus.set(s, (byStatus.get(s) ?? 0) + 1);
  }
  lines.push(`Total missions stored: ${list.length}`);
  if (byStatus.size > 0) {
    const parts = [...byStatus.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([s, n]) => `${s}=${n}`);
    lines.push(`By status: ${parts.join(", ")}`);
  }
  lines.push("");
  lines.push("-".repeat(70));

  if (list.length === 0) {
    lines.push("(no missions in the store)");
    return lines.join("\n");
  }

  for (const m of list) {
    const legs = Array.isArray(m?.legs) ? m.legs : [];
    lines.push("");
    lines.push(`mission ${safeStr(m?.id, "(no id)")}`);
    lines.push(`  title    : ${safeStr(m?.title, "")}`);
    lines.push(`  giver    : ${safeStr(m?.giver, "")}`);
    lines.push(
      `  variant  : ${safeStr(m?.variant, "")}   grade: ${safeStr(m?.grade, "")}`,
    );
    lines.push(`  status   : ${safeStr(m?.status, "(unknown)")}`);
    lines.push(`  source   : ${safeStr(m?.source, "(unknown)")}`);
    lines.push(
      `  payout   : ${m?.payout == null ? "—" : m.payout} (${safeStr(m?.payoutConfidence, "unknown")})`,
    );
    lines.push(`  legs     : ${legs.length}`);
    for (const l of legs) {
      const done = l?.completed ? "done" : "open";
      lines.push(
        `    - [${safeStr(l?.kind, "?")}] ${safeStr(l?.commodity, "(no commodity)")}` +
          ` ${num(l?.scuDelivered)}/${num(l?.scuTotal)} SCU` +
          ` -> ${safeStr(l?.location, "(no location)")} (${done}) [${safeStr(l?.id, "?")}]`,
      );
    }
  }

  return lines.join("\n");
}

/** Append a salvage-run summary to the captured-state report, if any runs exist. */
export function buildSalvageStateText(runs: SalvageRun[]): string {
  const list = Array.isArray(runs) ? runs : [];
  if (list.length === 0) return "";

  const lines: string[] = [];
  lines.push("");
  lines.push("");
  lines.push("SALVAGE RUNS (app state)");
  lines.push("=".repeat(70));
  lines.push(`Total salvage runs stored: ${list.length}`);
  for (const r of list) {
    const stripped = Array.isArray(r?.stripped) ? r.stripped : [];
    lines.push("");
    lines.push(`run ${safeStr(r?.id, "(no id)")}`);
    lines.push(`  status     : ${safeStr(r?.status, "(unknown)")}`);
    lines.push(`  crewSize   : ${num(r?.crewSize)}`);
    lines.push(
      `  materials  : rmc=${num(r?.rmcScu)} cmat=${num(r?.cmatScu)} construction=${num(r?.constructionScu)} SCU`,
    );
    lines.push(`  components : ${stripped.length}`);
    for (const s of stripped) {
      lines.push(
        `    - ${safeStr(s?.type, "?")} ${safeStr(s?.model, "")} x${num(s?.qty)} @ ${num(s?.sellPriceEach)} (${s?.sold ? "sold" : "unsold"})`,
      );
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// report.txt header
// ---------------------------------------------------------------------------

export interface ReportHeaderInput {
  /** The user's free-text description of the problem. */
  description: string;
  /** Generated-at timestamp (ISO). */
  generatedAt: string;
  appVersion: string;
  electron: string;
  platform: string;
  arch: string;
  /** Current app mode (cargo | salvage). */
  mode: string;
}

/** Build the report.txt header (description + environment). Pure + defensive. */
export function buildReportHeader(input: ReportHeaderInput): string {
  const lines: string[] = [];
  lines.push("SC Tracker — Issue Report");
  lines.push("=".repeat(70));
  lines.push(`Generated : ${safeStr(input?.generatedAt, "")}`);
  lines.push(`App ver   : ${safeStr(input?.appVersion, "")}`);
  lines.push(
    `Runtime   : electron ${safeStr(input?.electron, "")} · ${safeStr(input?.platform, "")}/${safeStr(input?.arch, "")}`,
  );
  lines.push(`Mode      : ${safeStr(input?.mode, "")}`);
  lines.push("");
  lines.push("-".repeat(70));
  lines.push("WHAT THE USER REPORTED");
  lines.push("-".repeat(70));
  lines.push(safeStr(input?.description, "(no description provided)"));
  lines.push("");
  lines.push("-".repeat(70));
  lines.push("WHAT'S IN THIS REPORT");
  lines.push("-".repeat(70));
  lines.push("  report.txt             — this file");
  lines.push("  settings.json          — app settings (username redacted)");
  lines.push("  captured-state.txt     — what the APP stored (missions/legs)");
  lines.push(
    "  game-log-missions.txt  — sanitized mission-event lines from Game.log",
  );
  lines.push("                           (player handle + GEID redacted)");
  lines.push(
    "  main.log[.1]           — the app's own log (username redacted)",
  );
  lines.push("  app-info.json          — runtime/version snapshot");
  lines.push("");
  lines.push("Compare game-log-missions.txt (what the game logged) against");
  lines.push("captured-state.txt (what the app stored) to pinpoint a drop.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Small defensive formatting helpers
// ---------------------------------------------------------------------------

function safeStr(v: unknown, fallback: string): string {
  if (v === null || v === undefined) return fallback;
  try {
    const s = String(v);
    return s.length > 0 ? s : fallback;
  } catch {
    return fallback;
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
