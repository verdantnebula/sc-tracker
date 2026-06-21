// ============================================================================
// logger.ts — main-process file logging (rotating, crash-safe)
// ----------------------------------------------------------------------------
// Mirrors the main process's console.log / console.warn / console.error to a
// rotating file at `<userData>/logs/main.log` so that, when a user reports an
// issue, the diagnostics collector (scripts/collect-diagnostics.ps1) can ship the
// recent main-process log back to the maintainer. The existing `[main] …` lines,
// the corruption-recovery / quarantine warnings, and the uncaughtException /
// unhandledRejection handlers in main.ts all flow through console, so wiring at
// the console layer captures them with zero changes to the call sites.
//
// Defensive by design (a diagnostics aid must NEVER break the app):
//   - every disk touch is wrapped in try/catch and can never throw to a caller;
//   - if the log dir/file can't be created or written, logging silently degrades
//     to console-only — the app keeps running exactly as before;
//   - console output is preserved (we wrap, we don't replace) so `npm run dev`
//     and any attached terminal still show everything.
//
// The core (createFileLogger) is pure and injectable (path + an fs-shim), so the
// rotation and unwritable-path behaviour are unit-testable on a temp dir without
// touching the real userData file (see logger.test.ts). installConsoleLogger()
// is the impure wiring used by main.ts.
// ============================================================================

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Rotate main.log once it exceeds this many bytes (~1.5 MB). */
export const MAX_LOG_BYTES = 1_500_000;

/** Console methods we mirror to the file. */
const LEVELS = ["log", "warn", "error"] as const;
export type LogLevel = (typeof LEVELS)[number];

// ---------------------------------------------------------------------------
// fs shim — injectable so tests can simulate an unwritable filesystem
// ---------------------------------------------------------------------------

export interface LoggerFs {
  existsSync: (p: string) => boolean;
  mkdirSync: (p: string, opts: { recursive: boolean }) => void;
  statSync: (p: string) => { size: number };
  appendFileSync: (p: string, data: string) => void;
  renameSync: (from: string, to: string) => void;
  writeFileSync: (p: string, data: string) => void;
}

/** The real node:fs surface the logger uses, bundled into the injectable shape. */
const realFs: LoggerFs = {
  existsSync,
  mkdirSync,
  statSync,
  appendFileSync,
  renameSync,
  writeFileSync,
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Render console arguments to a single line, the way a terminal roughly would:
 * strings as-is, Errors as their stack/message, everything else JSON-ish. Never
 * throws (a value with a circular ref or a throwing toJSON falls back to String).
 */
function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  try {
    if (typeof arg === "object" && arg !== null) return JSON.stringify(arg);
    return String(arg);
  } catch {
    return String(arg);
  }
}

/** Build one timestamped, levelled log line (no trailing newline). */
export function formatLine(
  level: LogLevel,
  args: unknown[],
  now: Date = new Date(),
): string {
  const ts = now.toISOString();
  const body = args.map(formatArg).join(" ");
  return `${ts} [${level.toUpperCase()}] ${body}`;
}

// ---------------------------------------------------------------------------
// Core file logger (pure-ish: all fs access goes through the injected shim)
// ---------------------------------------------------------------------------

export interface FileLogger {
  /** Append one formatted line for `level` + `args`. Never throws. */
  write: (level: LogLevel, args: unknown[]) => void;
  /** Absolute path of the active log file. */
  readonly logFile: string;
  /** Absolute path of the single rotation file. */
  readonly rotatedFile: string;
}

/**
 * Create a file logger writing to `<logDir>/main.log`, rotating to `main.log.1`
 * once the active file exceeds MAX_LOG_BYTES (the previous .1 is overwritten, so
 * at most two files exist). All filesystem operations go through `fs` (injectable)
 * and are wrapped so a single failure (unwritable dir, locked file, full disk)
 * degrades to a no-op instead of throwing into the caller's console call.
 *
 * `onFailure` is invoked at most ONCE (the first time a write fails) so a broken
 * log target is surfaced to the original console without spamming. It must never
 * throw; we guard it too.
 */
export function createFileLogger(
  logDir: string,
  options: {
    fs?: LoggerFs;
    now?: () => Date;
    onFailure?: (err: unknown) => void;
  } = {},
): FileLogger {
  const fs = options.fs ?? realFs;
  const now = options.now ?? (() => new Date());
  const logFile = join(logDir, "main.log");
  const rotatedFile = join(logDir, "main.log.1");

  let dirReady = false;
  let failed = false;

  function ensureDir(): void {
    if (dirReady) return;
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    dirReady = true;
  }

  function sizeOf(p: string): number {
    try {
      return fs.existsSync(p) ? fs.statSync(p).size : 0;
    } catch {
      return 0;
    }
  }

  /** Rotate main.log -> main.log.1 when it has grown past the cap. */
  function rotateIfNeeded(): void {
    if (sizeOf(logFile) <= MAX_LOG_BYTES) return;
    // Overwrite any existing .1 by renaming on top of it. On Windows rename onto
    // an existing target can EPERM, so fall back to truncate-then-rename.
    try {
      fs.renameSync(logFile, rotatedFile);
    } catch {
      try {
        // Best-effort: clear the old rotation, then move. If even this fails we
        // simply keep appending to the (now oversized) main.log — never fatal.
        fs.writeFileSync(rotatedFile, "");
        fs.renameSync(logFile, rotatedFile);
      } catch {
        /* keep appending to main.log; size cap is best-effort, not a guarantee */
      }
    }
  }

  function reportFailureOnce(err: unknown): void {
    if (failed) return;
    failed = true;
    try {
      options.onFailure?.(err);
    } catch {
      /* onFailure must never re-enter / throw */
    }
  }

  function write(level: LogLevel, args: unknown[]): void {
    try {
      ensureDir();
      rotateIfNeeded();
      fs.appendFileSync(logFile, formatLine(level, args, now()) + "\n");
    } catch (err) {
      // Disk is unwritable (permissions, full, locked). Degrade silently to
      // console-only; the app must keep running. Surface the first failure once.
      reportFailureOnce(err);
    }
  }

  return { write, logFile, rotatedFile };
}

// ---------------------------------------------------------------------------
// Console wiring (impure — used by main.ts)
// ---------------------------------------------------------------------------

export interface InstalledLogger {
  /** The underlying file logger (path getters useful for tests / logging). */
  logger: FileLogger;
  /** Restore the original console methods (used by tests; rarely in prod). */
  uninstall: () => void;
}

/**
 * Wrap console.log/warn/error so each call is ALSO mirrored to the rotating file
 * at `<logDir>/main.log`. The original console methods are preserved and still
 * called first (so terminal output is unchanged); the file write is best-effort
 * and wrapped, so a logging failure can never disturb the original console call.
 *
 * Returns an uninstall() that restores the originals. Idempotent guards are not
 * needed in production (called once at boot), but uninstall keeps tests clean.
 */
export function installConsoleLogger(
  logDir: string,
  options: { fs?: LoggerFs; now?: () => Date } = {},
): InstalledLogger {
  // Capture the real console so the file logger's own failure notice (and every
  // mirrored call) goes to the genuine terminal, not back through our wrapper.
  const originals: Record<LogLevel, (...args: unknown[]) => void> = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  const logger = createFileLogger(logDir, {
    ...options,
    onFailure: (err) => {
      originals.warn(
        "[logger] file logging disabled (could not write log file):",
        err instanceof Error ? err.message : String(err),
      );
    },
  });

  for (const level of LEVELS) {
    console[level] = (...args: unknown[]): void => {
      // Original console FIRST so terminal behaviour is identical even if the
      // file write throws somehow (it shouldn't — write() is fully guarded).
      originals[level](...args);
      logger.write(level, args);
    };
  }

  function uninstall(): void {
    for (const level of LEVELS) {
      console[level] = originals[level];
    }
  }

  return { logger, uninstall };
}

// ---------------------------------------------------------------------------
// app-info.json — a tiny startup environment snapshot for diagnostics
// ---------------------------------------------------------------------------

/** The diagnostics environment snapshot written once at startup. */
export interface AppInfo {
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  startedAt: string;
}

/**
 * Build the app-info snapshot from `app.getVersion()` + process.versions/platform.
 * Pure (takes the version + a clock), so it's trivially testable. The collector
 * script reads the resulting file so it can report the app/runtime versions a user
 * is on WITHOUT needing the app to be running at collect time.
 */
export function buildAppInfo(
  appVersion: string,
  now: () => Date = () => new Date(),
): AppInfo {
  return {
    appVersion,
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
    platform: process.platform,
    arch: process.arch,
    startedAt: now().toISOString(),
  };
}

/**
 * Safe-write `app-info.json` at `<userData>/app-info.json`. Fully guarded: a
 * write failure is logged (via console, which is mirrored to the log file) and
 * swallowed — writing the diagnostics snapshot must never block or crash boot.
 * Returns true on success, false if the write was skipped/failed.
 */
export function writeAppInfo(
  userDataDir: string,
  info: AppInfo,
  fs: Pick<LoggerFs, "existsSync" | "mkdirSync" | "writeFileSync"> = realFs,
): boolean {
  const target = join(userDataDir, "app-info.json");
  try {
    if (!fs.existsSync(dirname(target))) {
      fs.mkdirSync(dirname(target), { recursive: true });
    }
    fs.writeFileSync(target, JSON.stringify(info, null, 2));
    return true;
  } catch (err) {
    console.warn(
      "[logger] could not write app-info.json:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
