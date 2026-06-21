// ============================================================================
// diagnosticsExport.ts — impure orchestration for the "Collect Logs" export
// ----------------------------------------------------------------------------
// Builds the issue-report folder + zip on the user's Desktop. All fs/zip I/O
// lives here; the PURE formatting + redaction lives in diagnosticsReport.ts /
// redact.ts (both unit-tested). This module is the impure glue main.ts calls
// from the diagnostics:exportReport IPC handler.
//
// Defensive throughout — a reporting tool must NEVER crash the app:
//   - every file copy/read is wrapped; a missing source becomes a "(not found)"
//     note inside the report rather than an exception;
//   - the whole build is wrapped so the handler can return an { error } result
//     instead of throwing into the renderer.
//
// REDACTION is mandatory and verified: the Game.log extract is run through a
// redactor built from the player handle + GEID detected in the log, plus a
// blanket pass for Player[…]/PlayerId[…]/Users\<name>. The copied app files
// (settings.json, main.log) are run through the same redactor so a username (or
// a handle that leaked into a path/log line) is stripped there too.
// ============================================================================

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import type { Mission, SalvageRun, AppMode } from "@shared/types";
import {
  buildReportHeader,
  buildCapturedStateText,
  buildSalvageStateText,
  extractMissionEventLines,
} from "./diagnosticsReport";
import {
  createRedactor,
  detectPlayerIdentity,
  type PlayerIdentity,
} from "./redact";

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface ExportContext {
  /** The user's free-text problem description (from the dialog textarea). */
  description: string;
  /** Desktop dir (preferred). */
  desktopDir: string;
  /** Fallback dir when Desktop is missing/unwritable (the app's userData). */
  userDataDir: string;
  /** app.getVersion(). */
  appVersion: string;
  /** Current app mode for the header. */
  mode: AppMode;
  /** Resolved current Game.log path (configured-or-default). */
  gameLogPath: string;
  /** Windows username to redact from paths/logs (or null). */
  windowsUsername: string | null;
  /** Snapshot of the store's missions ("what the app captured"). */
  missions: Mission[];
  /** Snapshot of salvage runs (summarized if any). */
  salvageRuns: SalvageRun[];
  /** A clock, injectable for tests. */
  now?: () => Date;
}

export interface ExportOutcome {
  folder: string;
  zip: string;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Build the report folder + zip. Returns the created paths. Throws only on a
 * genuinely unrecoverable failure (can't create the folder in EITHER Desktop or
 * userData) — the IPC handler catches that and returns an { error } result.
 */
export function buildDiagnosticsReport(ctx: ExportContext): ExportOutcome {
  const now = ctx.now ?? (() => new Date());
  const stamp = timestampSlug(now());
  const folderName = `sc-tracker-report-${stamp}`;

  // Choose a writable base dir: Desktop first, then userData.
  const base = pickWritableBase(ctx.desktopDir, ctx.userDataDir);
  const folder = join(base, folderName);
  mkdirSync(folder, { recursive: true });

  // ---- read the Game.log ONCE so we can detect identity + extract -----------
  const liveLog = safeReadText(ctx.gameLogPath);

  // Identity is detected from the live log first; if the live log is empty we
  // fall back to scanning a recent backup so redaction still works.
  let identity: PlayerIdentity = detectPlayerIdentity(liveLog ?? "");
  const backups = recentBackups(ctx.gameLogPath, 2);
  const backupTexts: { path: string; text: string }[] = [];
  for (const b of backups) {
    const t = safeReadText(b);
    if (t !== null) backupTexts.push({ path: b, text: t });
  }
  if (identity.handle === null && identity.geid === null) {
    for (const b of backupTexts) {
      const id = detectPlayerIdentity(b.text);
      if (id.handle || id.geid) {
        identity = id;
        break;
      }
    }
  }

  const redact = createRedactor(identity, ctx.windowsUsername);

  // ---- report.txt -----------------------------------------------------------
  const header = buildReportHeader({
    description: ctx.description,
    generatedAt: now().toISOString(),
    appVersion: ctx.appVersion,
    electron: process.versions.electron ?? "",
    platform: process.platform,
    arch: process.arch,
    mode: ctx.mode,
  });
  // The description is user-typed; redact it too (a user could paste a path).
  safeWrite(join(folder, "report.txt"), redact(header));

  // ---- settings.json (redacted copy) ---------------------------------------
  writeRedactedCopy(
    join(folder, "settings.json"),
    join(ctx.userDataDir, "settings.json"),
    redact,
    "settings.json not found (no custom LIVE folder configured).",
  );

  // ---- captured-state.txt --------------------------------------------------
  const captured =
    buildCapturedStateText(ctx.missions) +
    buildSalvageStateText(ctx.salvageRuns);
  safeWrite(join(folder, "captured-state.txt"), redact(captured));

  // ---- game-log-missions.txt (sanitized extract) ---------------------------
  safeWrite(
    join(folder, "game-log-missions.txt"),
    buildGameLogExtract(ctx.gameLogPath, liveLog, backupTexts, redact),
  );

  // ---- main.log (+ .1) redacted copies -------------------------------------
  const logsDir = join(ctx.userDataDir, "logs");
  writeRedactedCopy(
    join(folder, "main.log"),
    join(logsDir, "main.log"),
    redact,
    "main.log not found (the app hasn't produced a log yet).",
  );
  if (existsSync(join(logsDir, "main.log.1"))) {
    writeRedactedCopy(
      join(folder, "main.log.1"),
      join(logsDir, "main.log.1"),
      redact,
      "main.log.1 not present.",
    );
  }

  // ---- app-info.json (copied if present; no identity, but redact for paths) -
  writeRedactedCopy(
    join(folder, "app-info.json"),
    join(ctx.userDataDir, "app-info.json"),
    redact,
    "app-info.json not found (the app hasn't recorded a startup snapshot yet).",
  );

  // ---- zip the folder beside itself ----------------------------------------
  const zip = join(base, `${folderName}.zip`);
  zipFolder(folder, zip);

  return { folder, zip };
}

// ---------------------------------------------------------------------------
// game-log extract assembly (live + recent backups)
// ---------------------------------------------------------------------------

function buildGameLogExtract(
  gameLogPath: string,
  liveLog: string | null,
  backupTexts: { path: string; text: string }[],
  redact: (s: string) => string,
): string {
  const out: string[] = [];
  out.push("SANITIZED Game.log MISSION-EVENT EXTRACT");
  out.push("=".repeat(70));
  out.push("Player handle + GEID are redacted to <PLAYER> / <PLAYERID>.");
  out.push(
    "Mission ids, commodity, SCU, location and timestamps are KEPT (needed to triage).",
  );
  out.push(
    "Only mission-lifecycle lines are included; chat/combat/etc. are dropped.",
  );
  out.push("");

  // Current Game.log first.
  out.push("-".repeat(70));
  out.push(`# Current Game.log: ${redact(gameLogPath)}`);
  out.push("-".repeat(70));
  if (liveLog === null) {
    out.push("(Game.log not found or unreadable at the resolved path.)");
  } else {
    const lines = extractMissionEventLines(liveLog, redact);
    out.push(`# ${lines.length} mission-event line(s) kept`);
    out.push(...lines);
  }

  // Recent backups (already redacted per line).
  for (const b of backupTexts) {
    out.push("");
    out.push("-".repeat(70));
    out.push(`# logbackup: ${redact(b.path)}`);
    out.push("-".repeat(70));
    const lines = extractMissionEventLines(b.text, redact);
    out.push(`# ${lines.length} mission-event line(s) kept`);
    out.push(...lines);
  }

  return out.join("\n");
}

/** The most-recent N logbackups/*.log sibling files, newest first. */
function recentBackups(gameLogPath: string, n: number): string[] {
  try {
    const dir = join(dirname(gameLogPath), "logbackups");
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".log"))
      .map((f) => join(dir, f));
    return files
      .map((p) => ({ p, m: safeMtime(p) }))
      .sort((a, b) => b.m - a.m)
      .slice(0, Math.max(0, n))
      .map((x) => x.p);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Zip via PowerShell (matches the project's existing CreateFromDirectory approach;
// no new npm dependency). Falls back to leaving the folder if zipping fails.
// ---------------------------------------------------------------------------

function zipFolder(folder: string, zipPath: string): void {
  try {
    if (existsSync(zipPath)) {
      // Remove a stale zip so CreateFromDirectory doesn't throw on an existing file.
      try {
        rmSync(zipPath, { force: true });
      } catch {
        /* best effort */
      }
    }
    // Use .NET ZipFile.CreateFromDirectory via PowerShell — present on every
    // supported Windows, no extra dependency, and the approach already used for
    // release packaging in this project.
    const ps =
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
      `[System.IO.Compression.ZipFile]::CreateFromDirectory(` +
      `'${escapePs(folder)}','${escapePs(zipPath)}')`;
    const res = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { windowsHide: true, encoding: "utf8" },
    );
    if (res.status !== 0 && !existsSync(zipPath)) {
      // Non-Windows or PowerShell unavailable: leave the folder; the caller can
      // still hand over the folder. We surface this by writing a note inside it.
      safeWrite(
        join(folder, "ZIP-FAILED.txt"),
        "Could not create a .zip automatically. Please zip this folder manually and send it.",
      );
    }
  } catch {
    /* zipping is best-effort; the folder itself is the fallback deliverable */
  }
}

/** Escape a path for embedding inside a single-quoted PowerShell string. */
function escapePs(p: string): string {
  return p.replace(/'/g, "''");
}

// ---------------------------------------------------------------------------
// fs helpers (all guarded)
// ---------------------------------------------------------------------------

function pickWritableBase(desktopDir: string, userDataDir: string): string {
  for (const dir of [desktopDir, userDataDir]) {
    try {
      if (dir && existsSync(dir)) return dir;
    } catch {
      /* try next */
    }
  }
  // Last resort: userData, creating it if needed (the caller's mkdir handles it).
  return userDataDir;
}

function writeRedactedCopy(
  dest: string,
  src: string,
  redact: (s: string) => string,
  missingNote: string,
): void {
  const text = safeReadText(src);
  if (text === null) {
    safeWrite(dest, missingNote);
    return;
  }
  safeWrite(dest, redact(text));
}

function safeReadText(path: string): string | null {
  try {
    if (!path || !existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function safeWrite(path: string, content: string): void {
  try {
    writeFileSync(path, content, "utf8");
  } catch {
    /* a single unwritable file must not abort the whole report */
  }
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function timestampSlug(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}
