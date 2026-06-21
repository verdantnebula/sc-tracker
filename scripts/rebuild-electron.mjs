// Rebuild the better-sqlite3 native binary for the INSTALLED Electron's ABI.
// ---------------------------------------------------------------------------
// The Electron version is derived dynamically from the installed `electron`
// package, so bumping Electron never requires editing this script or the npm
// scripts. Cross-shell safe: runs under cmd.exe / PowerShell / POSIX sh alike
// (npm on Windows executes scripts via cmd.exe, where `$(...)` does NOT expand,
// so a Node wrapper is used instead of inline shell command substitution).
//
// Mirrors the old inline command:
//   cd node_modules/better-sqlite3 && prebuild-install -r electron -t <ver> --arch x64 --force
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const electronVersion = require("electron/package.json").version;
const bsqliteDir = dirname(require.resolve("better-sqlite3/package.json"));

console.log(
  `[rebuild-electron] better-sqlite3 -> electron ${electronVersion} (x64)`,
);

const result = spawnSync(
  "prebuild-install",
  ["-r", "electron", "-t", electronVersion, "--arch", "x64", "--force"],
  { cwd: bsqliteDir, stdio: "inherit", shell: true },
);

if (result.status !== 0) {
  console.error(
    `[rebuild-electron] prebuild-install failed (exit ${result.status}).`,
  );
  process.exit(result.status ?? 1);
}
