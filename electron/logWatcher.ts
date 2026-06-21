// ============================================================================
// logWatcher.ts — chokidar tailer + historical backfill  (SPEC §4, §6)
// ----------------------------------------------------------------------------
// CONTRACT: watches the LIVE/Game.log file via chokidar (watching the DIRECTORY
// so a recreated file is picked up), tracks a byte offset, reads only the new
// bytes on change, splits lines, runs each through parseLine() (logParsers.ts),
// and forwards DomainEvents to a sink (the store). Handles rotation/truncation
// (size < lastOffset -> reset offset to 0). On startup it first backfills from
// LIVE/logbackups/*.log (oldest -> newest) to reconstruct mission history, then
// begins live tailing.
//
// Defensive (SPEC §2 ⚠): a missing dir, a transient read error, or a malformed
// line must never crash the watcher. Status is surfaced for the UI strip.
//
// OWNER: Phase 2 (parser/watcher). Emits DomainEvents; missionStore.ts applies
// them. Drives LogStatus + BackfillProgress for the UI.
// ============================================================================

import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { watch, type FSWatcher } from "chokidar";

import { parseLine } from "./logParsers";
import type { DomainEvent } from "./logParsers";
import type {
  BackfillProgress,
  LogConnectionState,
  LogStatus,
} from "@shared/types";

// ---------------------------------------------------------------------------
// Public interface (the integration seam — main.ts subscribes to these)
// ---------------------------------------------------------------------------

/**
 * Origin of an emitted event:
 *  - 'historical' : from a PAST session (logbackups backfill).
 *  - 'live'       : the current session — the live Game.log read from offset 0 on
 *                   startup PLUS the ongoing tail. The store uses this to decide
 *                   which non-terminal missions are "active".
 */
export type EventSource = "historical" | "live";

/** Callback the watcher invokes for each parsed event, tagged with its origin. */
export type DomainEventSink = (event: DomainEvent, source: EventSource) => void;

export interface LogWatcherOptions {
  /**
   * Explicit Game.log path. If omitted the default LIVE path is used. Always
   * overridable — never hardcode a single absolute path with no escape hatch.
   */
  logPath?: string;
  /** Called for every parsed domain event (live tail + backfill). */
  onEvent: DomainEventSink;
  /** Called when connection status changes (file found/lost, etc.). */
  onStatus?: (status: LogStatus) => void;
  /** Called as historical backfill progresses. */
  onBackfillProgress?: (progress: BackfillProgress) => void;
  /** UEX cache active flag, threaded through to LogStatus. Defaults false. */
  uexActive?: boolean;
}

export interface LogWatcher {
  /** Begin watching live + run the initial backfill. */
  start(): Promise<void>;
  /** Re-run the logbackups backfill scan (Re-sync button). */
  backfill(): Promise<void>;
  /** Stop watching and release the chokidar handle. */
  stop(): Promise<void>;
  /** Current connection status snapshot. */
  status(): LogStatus;
}

// ---------------------------------------------------------------------------
// Defaults & constants
// ---------------------------------------------------------------------------

/** Default LIVE Game.log path (overridable via options.logPath). */
export const DEFAULT_GAME_LOG_PATH =
  "C:/Program Files/Roberts Space Industries/StarCitizen/LIVE/Game.log";

/** Sibling backups directory name, relative to the Game.log directory. */
const LOG_BACKUPS_DIRNAME = "logbackups";

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Parse a chunk of raw text (one or more newline-separated log lines) into
 * DomainEvents. Trailing partial line handling is the caller's job — this
 * assumes complete lines. Malformed lines yield nothing (parseLine returns null).
 */
export function parseChunk(text: string): DomainEvent[] {
  const out: DomainEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const event = parseLine(line);
    if (event) out.push(event);
  }
  return out;
}

/**
 * Order logbackup file paths oldest -> newest. Star Citizen names backups with a
 * sortable timestamp; lexical sort matches chronological order. When names are
 * not sortable we fall back to mtime so newest events still win on dedupe.
 */
export function sortBackupsOldestFirst(dir: string, files: string[]): string[] {
  return [...files].sort((a, b) => {
    const an = a.toLowerCase();
    const bn = b.toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    // Tiebreak on mtime when lexical order is equal.
    try {
      return statSync(join(dir, a)).mtimeMs - statSync(join(dir, b)).mtimeMs;
    } catch {
      return 0;
    }
  });
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class LogWatcherImpl implements LogWatcher {
  private readonly logPath: string;
  private readonly logDir: string;
  private readonly logFileName: string;
  private readonly onEvent: DomainEventSink;
  private readonly onStatus?: (s: LogStatus) => void;
  private readonly onBackfillProgress?: (p: BackfillProgress) => void;
  private readonly uexActive: boolean;

  private watcher: FSWatcher | null = null;
  private lastOffset = 0;
  /** Carry-over for a trailing partial line between delta reads. */
  private pending = "";
  private state: LogConnectionState = "disconnected";

  constructor(options: LogWatcherOptions) {
    this.logPath = options.logPath ?? DEFAULT_GAME_LOG_PATH;
    this.logDir = dirname(this.logPath);
    this.logFileName = basename(this.logPath);
    this.onEvent = options.onEvent;
    this.onStatus = options.onStatus;
    this.onBackfillProgress = options.onBackfillProgress;
    this.uexActive = options.uexActive ?? false;
  }

  status(): LogStatus {
    return {
      state: this.state,
      logPath: existsSync(this.logPath) ? this.logPath : null,
      uexActive: this.uexActive,
    };
  }

  private setState(state: LogConnectionState): void {
    if (state === this.state) return;
    this.state = state;
    this.onStatus?.(this.status());
  }

  private emit(events: DomainEvent[], source: EventSource): void {
    for (const e of events) {
      try {
        this.onEvent(e, source);
      } catch {
        // A faulty consumer must not break the tail.
      }
    }
  }

  // --- Backfill ------------------------------------------------------------

  async backfill(): Promise<void> {
    const backupsDir = join(this.logDir, LOG_BACKUPS_DIRNAME);
    this.reportBackfill(0, "Scanning logbackups…", false);

    let files: string[] = [];
    try {
      if (existsSync(backupsDir)) {
        files = readdirSync(backupsDir).filter((f) =>
          f.toLowerCase().endsWith(".log"),
        );
      }
    } catch {
      files = [];
    }

    if (files.length === 0) {
      this.reportBackfill(100, "No history found.", true);
      return;
    }

    const ordered = sortBackupsOldestFirst(backupsDir, files);
    for (let i = 0; i < ordered.length; i++) {
      const full = join(backupsDir, ordered[i]);
      try {
        const text = readFileSync(full, "utf8");
        // logbackups are PAST sessions -> historical.
        this.emit(parseChunk(text), "historical");
      } catch {
        // Skip an unreadable/locked backup; keep going.
      }
      const progress = Math.round(((i + 1) / ordered.length) * 100);
      this.reportBackfill(
        progress,
        `Reconstructing history (${i + 1}/${ordered.length})…`,
        false,
      );
    }

    this.reportBackfill(100, "History reconstructed.", true);
  }

  private reportBackfill(progress: number, label: string, done: boolean): void {
    this.onBackfillProgress?.({
      progress,
      label,
      done,
    } satisfies BackfillProgress);
  }

  // --- Live tail -----------------------------------------------------------

  async start(): Promise<void> {
    // 1) Reconstruct history from PAST sessions (logbackups) first -> historical.
    await this.backfill();

    // 2) Read the CURRENT Game.log from offset 0 -> this IS the current session
    //    (it may already contain missions accepted BEFORE the app launched).
    //    Tag every event 'live' so those missions show up as active. Then begin
    //    tailing from the end of what we just read. (Previously this seeded the
    //    offset to EOF and skipped the current log entirely — the root of
    //    pre-launch missions never appearing as active.)
    this.lastOffset = 0;
    this.pending = "";
    this.readInitialLive();
    this.setState(existsSync(this.logPath) ? "connected" : "searching");

    // 3) Watch the DIRECTORY (not just the file) so a deleted/recreated Game.log
    //    on game restart is still picked up. chokidar v4 has no glob support; we
    //    filter events down to our target filename ourselves.
    // Use polling: Game.log is written by ANOTHER process (the game), and native
    // OS fs events can batch/miss such external appends — polling guarantees the
    // tail keeps up and behaves consistently across platforms. The cost (a stat
    // every `interval` ms on one directory) is negligible.
    this.watcher = watch(this.logDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 0, // top level only — don't descend into logbackups/
      usePolling: true,
      interval: 250,
      awaitWriteFinish: false,
    });

    const onChange = (changedPath: string): void => {
      if (basename(changedPath) !== this.logFileName) return;
      this.handleChange();
    };

    this.watcher
      .on("add", onChange)
      .on("change", onChange)
      .on("unlink", (p) => {
        if (basename(p) === this.logFileName) {
          this.lastOffset = 0;
          this.pending = "";
          this.setState("searching");
        }
      })
      .on("error", () => {
        // Swallow watcher errors; surface as a status downgrade.
        this.setState("searching");
      });

    // Pick up anything appended between offset-seed and watcher-ready.
    this.handleChange();
  }

  /**
   * Synchronously read the entire CURRENT Game.log (offset 0 -> EOF) and emit its
   * events tagged 'live' — this is the current session, possibly already holding
   * missions accepted before the app launched. Runs once at start() before the
   * tail is armed, advancing lastOffset to EOF so the tail continues seamlessly.
   * A trailing partial line (no newline) is carried in `pending`.
   */
  private readInitialLive(): void {
    let size: number;
    try {
      if (!existsSync(this.logPath)) return;
      size = statSync(this.logPath).size;
    } catch {
      return;
    }
    if (size === 0) return;

    let text: string;
    try {
      text = readFileSync(this.logPath, "utf8");
    } catch {
      // Locked/unreadable now; the tail's first poll will retry from offset 0.
      return;
    }
    this.lastOffset = size;

    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) {
      this.pending = text;
      return;
    }
    const complete = text.slice(0, lastNewline + 1);
    this.pending = text.slice(lastNewline + 1);
    this.emit(parseChunk(complete), "live");
  }

  /**
   * Read the bytes appended since lastOffset, parse complete lines, advance the
   * offset. Detects truncation/rotation (size < lastOffset) and resets to 0.
   */
  private handleChange(): void {
    let size: number;
    try {
      if (!existsSync(this.logPath)) {
        this.setState("searching");
        return;
      }
      size = statSync(this.logPath).size;
    } catch {
      this.setState("searching");
      return;
    }

    this.setState("connected");

    // Rotation / truncation: file shrank -> a new session began. Re-scan from 0.
    if (size < this.lastOffset) {
      this.lastOffset = 0;
      this.pending = "";
    }

    if (size === this.lastOffset) return; // nothing new

    const start = this.lastOffset;
    const end = size;
    this.lastOffset = size;

    const stream = createReadStream(this.logPath, {
      encoding: "utf8",
      start,
      end: end - 1, // createReadStream `end` is inclusive
    });

    let buffer = this.pending;
    stream.on("data", (chunk: string | Buffer) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    stream.on("error", () => {
      // Read failed (file locked mid-rotation). Keep pending; next event retries.
      this.pending = buffer;
    });
    stream.on("close", () => {
      // Hold back a trailing partial line (no newline yet) for the next read.
      const lastNewline = buffer.lastIndexOf("\n");
      if (lastNewline === -1) {
        this.pending = buffer;
        return;
      }
      const complete = buffer.slice(0, lastNewline + 1);
      this.pending = buffer.slice(lastNewline + 1);
      // Live tail -> current session.
      this.emit(parseChunk(complete), "live");
    });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.setState("disconnected");
  }
}

/**
 * Create a log watcher. The watcher backfills from logbackups on start(), then
 * tails Game.log via a chokidar directory watch with offset-delta reads.
 */
export function createLogWatcher(options: LogWatcherOptions): LogWatcher {
  return new LogWatcherImpl(options);
}
