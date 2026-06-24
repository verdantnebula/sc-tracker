// ============================================================================
// autoUpdate.ts — NON-FORCED auto-update (electron-updater) wiring  (v1.0.2)
// ----------------------------------------------------------------------------
// FULLY USER-CONTROLLED. The app checks GitHub Releases on launch and, if a
// newer version exists, downloads it in the BACKGROUND — but it NEVER installs
// or restarts on its own. The downloaded update sits ready until the user clicks
// "Restart & Update" in the banner, which calls installUpdate() -> quitAndInstall.
//
// Key autoUpdater settings (the whole point of "non-forced"):
//   - autoDownload          = true   → fetch the delta/full installer quietly.
//   - autoInstallOnAppQuit  = false  → do NOT silently install on the next quit.
//                                      Without this, electron-updater would apply
//                                      a downloaded update the next time the app
//                                      closes — exactly the forced behavior we
//                                      are avoiding. Install happens ONLY via the
//                                      explicit quitAndInstall() below.
//
// Activation gate: only when `app.isPackaged` AND settings.updateCheckEnabled.
//   - A dev/unpackaged run has no real release feed and no installer, so we no-op
//     (electron-updater would throw "dev-app-update.yml not found" otherwise).
//   - When the user disables update checks we never even import the updater.
//
// Defensive by design: every updater interaction is wrapped so a failure (no
// network, no release yet, rate-limited GitHub) is reported as a quiet `error`
// status and NEVER throws into boot or shows a blocking dialog. The renderer
// treats `error` as "do nothing" — checking and finding nothing is normal.
//
// electron-updater is imported DYNAMICALLY so a normal launch with checks off (or
// a dev run) pays nothing for the library, and unit tests can import the pure
// helpers in this file without pulling electron-updater into the test runtime.
// ============================================================================

import type { UpdateStatus } from "@shared/types";

/** Re-check for updates on this cadence while the app stays open (6 hours). */
export const UPDATE_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing — no electron / electron-updater)
// ---------------------------------------------------------------------------

/**
 * Decide whether the auto-updater should run at all. Pure so it is unit-testable
 * without Electron: the updater is active ONLY in the packaged app AND only when
 * the user has left update checks enabled. A dev/unpackaged run never updates.
 */
export function shouldRunAutoUpdate(
  isPackaged: boolean,
  updateCheckEnabled: boolean,
): boolean {
  return isPackaged === true && updateCheckEnabled === true;
}

/**
 * Clamp a raw electron-updater download percent (a float 0..100, occasionally
 * slightly out of range) to an integer 0..100 for the renderer's progress bar.
 * Pure + total: a non-finite/garbage value collapses to 0.
 */
export function clampPercent(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Coerce an electron-updater UpdateInfo-ish object to a display version string.
 * Pure + total: anything without a string `version` yields "" so the caller can
 * still emit a well-formed status (the banner shows "an update" rather than
 * crashing on a missing field). We never trust the shape blindly.
 */
export function versionFrom(info: unknown): string {
  if (info && typeof info === "object") {
    const v = (info as { version?: unknown }).version;
    if (typeof v === "string") return v;
  }
  return "";
}

/**
 * Resolve electron-updater's `autoUpdater` export across CJS/ESM interop shapes.
 * electron-updater is CommonJS; under the packaged build's ESM/CJS interop its
 * `autoUpdater` getter is only reliably reachable via `mod.default.autoUpdater`,
 * NOT `mod.autoUpdater` — reading the latter yields undefined and a later
 * `autoUpdater.autoDownload = …` throws, silently disabling updates. Pure +
 * total: anything that isn't an object, or neither interop shape, yields
 * undefined so the caller can guard instead of crashing.
 */
export function resolveAutoUpdater(mod: unknown): unknown {
  if (!mod || typeof mod !== "object") return undefined;
  const m = mod as {
    autoUpdater?: unknown;
    default?: { autoUpdater?: unknown };
  };
  return m.autoUpdater ?? m.default?.autoUpdater ?? undefined;
}

// ---------------------------------------------------------------------------
// Updater wiring (impure — used by main.ts at runtime)
// ---------------------------------------------------------------------------

/** What the updater module needs from main: a way to push status to renderers. */
export interface AutoUpdateDeps {
  /** True in the packaged app (app.isPackaged). */
  isPackaged: boolean;
  /** The persisted updateCheckEnabled flag (settings). */
  updateCheckEnabled: boolean;
  /** Push an UpdateStatus to every renderer (main broadcasts on update:status). */
  emit: (status: UpdateStatus) => void;
}

/** Handle returned by initAutoUpdate so main can install / dispose. */
export interface AutoUpdateHandle {
  /**
   * Install a downloaded update and restart. Called ONLY on the user's explicit
   * click. Safe to call when nothing is downloaded (quitAndInstall is a no-op in
   * that case) and safe when the updater never initialized (no-op). Never throws.
   */
  install: () => void;
  /**
   * Trigger an update check on demand (the user clicked "Check for updates").
   * Shares the SAME guarded, never-throwing path as the initial/periodic check,
   * so a manual check behaves identically: failures surface as a quiet `error`
   * status, never an exception or blocking dialog. No-op when gated off.
   */
  checkNow: () => void;
  /** Stop the recheck interval (called on before-quit). Idempotent, never throws. */
  dispose: () => void;
}

/** A disabled/no-op handle — returned when the updater is gated off. */
const NOOP_HANDLE: AutoUpdateHandle = {
  install: () => {},
  checkNow: () => {},
  dispose: () => {},
};

/**
 * Initialize electron-updater for NON-FORCED auto-update. No-ops (returns a
 * no-op handle) when gated off (dev/unpackaged or checks disabled). On success it
 * wires the updater events to `emit`, kicks an initial check, and schedules a
 * periodic recheck. Fully guarded: a load/check failure degrades to a quiet
 * `error` emit and a no-op handle rather than throwing into boot.
 */
export async function initAutoUpdate(
  deps: AutoUpdateDeps,
): Promise<AutoUpdateHandle> {
  if (!shouldRunAutoUpdate(deps.isPackaged, deps.updateCheckEnabled)) {
    return NOOP_HANDLE;
  }

  let autoUpdater: import("electron-updater").AppUpdater | undefined;
  try {
    // Dynamic import: only loaded in the packaged, opted-in path.
    const mod = await import("electron-updater");
    // Resolve across CJS/ESM interop shapes. In the packaged build the
    // `autoUpdater` export is only reachable via `mod.default.autoUpdater`;
    // reading `mod.autoUpdater` directly yields undefined (the v2.3.0 bug).
    autoUpdater = resolveAutoUpdater(mod) as
      | import("electron-updater").AppUpdater
      | undefined;
  } catch (err) {
    // Library missing/broken — should never happen in a packaged build, but a
    // failure here must not break boot. Report quietly and disable.
    deps.emit({ state: "error", message: stringifyError(err) });
    return NOOP_HANDLE;
  }

  // Guard: if neither interop shape exposed `autoUpdater`, do NOT proceed to the
  // `autoUpdater.autoDownload = …` assignment below — that is precisely what
  // threw a TypeError and silently disabled updates. Report and no-op instead.
  if (!autoUpdater) {
    console.warn("[update] electron-updater autoUpdater export not found");
    deps.emit({
      state: "error",
      message: "Updater unavailable (autoUpdater export missing).",
    });
    return NOOP_HANDLE;
  }

  // Bind to a const so the non-undefined narrowing holds inside the event
  // handlers and the returned handle's closures (a captured `let` would widen
  // back to `… | undefined` inside callbacks).
  const updater = autoUpdater;

  // NON-FORCED configuration. Background download yes; silent install NO.
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false;
  // Route electron-updater's internal logger to console.* so its diagnostics
  // land in main.log (the app pipes console.* -> main.log via
  // installConsoleLogger). Without this a runtime updater failure leaves NO
  // trace — exactly the silent-failure mode we are fixing.
  updater.logger = {
    info: (m: unknown) =>
      console.log("[update]", typeof m === "string" ? m : JSON.stringify(m)),
    warn: (m: unknown) =>
      console.warn("[update]", typeof m === "string" ? m : JSON.stringify(m)),
    error: (m: unknown) =>
      console.error("[update]", typeof m === "string" ? m : JSON.stringify(m)),
    debug: (m: unknown) =>
      console.log(
        "[update:debug]",
        typeof m === "string" ? m : JSON.stringify(m),
      ),
  } as unknown as typeof updater.logger;

  // Track which download-progress milestones we've already logged so a long
  // download doesn't spam main.log with a line per progress event. We log only
  // when the rounded percent first crosses a 0/25/50/75/100 boundary.
  const loggedMilestones = new Set<number>();
  const PROGRESS_MILESTONES = [0, 25, 50, 75, 100];

  // --- Lifecycle events -> renderer push (all guarded by emit being safe). ---
  // Each handler also emits an explicit "[update] …" console line so the updater
  // lifecycle is visible in main.log even though the internal logger is wired.
  updater.on("checking-for-update", () => {
    console.log("[update] checking…");
    deps.emit({ state: "checking" });
  });
  updater.on("update-available", (info) => {
    console.log(`[update] available: ${versionFrom(info)}`);
    deps.emit({ state: "available", version: versionFrom(info) });
  });
  updater.on("update-not-available", () => {
    console.log("[update] up to date");
    deps.emit({ state: "none" });
  });
  updater.on("download-progress", (p) => {
    const percent = clampPercent(
      (p as { percent?: unknown } | undefined)?.percent,
    );
    // Log only the first time we cross each milestone (avoids per-event spam).
    for (const m of PROGRESS_MILESTONES) {
      if (percent >= m && !loggedMilestones.has(m)) {
        loggedMilestones.add(m);
        console.log(`[update] downloading… ${m}%`);
      }
    }
    deps.emit({ state: "progress", percent });
  });
  updater.on("update-downloaded", (info) => {
    console.log(`[update] downloaded: ${versionFrom(info)}`);
    deps.emit({ state: "downloaded", version: versionFrom(info) });
  });
  updater.on("error", (err) => {
    // Offline / no release / rate-limited — all land here. Quiet, non-blocking.
    console.warn("[update] check failed:", stringifyError(err));
    deps.emit({ state: "error", message: stringifyError(err) });
  });

  // Kick an initial check. Never throws — checkForUpdates rejects on failure,
  // which we surface as a quiet `error` status (so a manual check can never
  // silently do nothing) in addition to the 'error' event the updater emits.
  const safeCheck = (): void => {
    updater.checkForUpdates().catch((err) => {
      console.warn("[update] checkForUpdates rejected:", stringifyError(err));
      deps.emit({ state: "error", message: stringifyError(err) });
    });
  };
  safeCheck();

  // Periodic recheck while the app stays open, so a long-running session still
  // learns about a release published after launch.
  const timer = setInterval(safeCheck, UPDATE_RECHECK_INTERVAL_MS);
  // Don't let the interval keep the process alive on its own.
  if (typeof timer.unref === "function") timer.unref();

  return {
    install: () => {
      try {
        // isSilent=false (show the installer UI), isForceRunAfter=true (relaunch
        // after install). Only ever reached on the user's explicit click.
        updater.quitAndInstall(false, true);
      } catch (err) {
        console.warn("[update] quitAndInstall failed:", stringifyError(err));
      }
    },
    checkNow: () => {
      // Manual ("Check for updates") trigger — reuse the SAME guarded path as
      // the initial/periodic check so it can never throw into the IPC handler.
      // Emit a `checking` status FIRST so the gear UI always gets feedback and
      // can never silently do nothing, even if the check resolves instantly.
      deps.emit({ state: "checking" });
      safeCheck();
    },
    dispose: () => {
      try {
        clearInterval(timer);
      } catch {
        /* nothing to clean up */
      }
    },
  };
}

/** Compact, never-throwing error -> string for quiet logging. */
function stringifyError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "unknown error";
  }
}
