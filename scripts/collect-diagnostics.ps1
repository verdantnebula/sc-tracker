<#
.SYNOPSIS
    SC Cargo Tracker - diagnostics collector.

.DESCRIPTION
    Gathers a single, human-readable, REDACTED diagnostics report so a user can
    attach it when reporting an issue. It reads only the standard per-user app data
    directory ("$env:APPDATA\sc-cargo-tracker") plus a couple of well-known paths -
    it does NOT need Node, the repo, or the app to be running.

    PRIVACY:
      * Every emitted line is run through a redactor that replaces the current
        Windows username (in any path or text) with <USER>.
      * Game.log CONTENTS are never included - only its file status (exists/size/
        last-write). The log can contain gameplay / player data.

    The report is written to the user's Desktop as:
      sc-tracker-diagnostics-<yyyyMMdd-HHmmss>.txt

.NOTES
    Run:  powershell -ExecutionPolicy Bypass -File scripts\collect-diagnostics.ps1
    Fully defensive: a missing file or directory yields a clear "not found" line,
    never a crash.
#>

# Never let a stray error abort the whole collection - each probe guards itself.
$ErrorActionPreference = "Continue"

# ---------------------------------------------------------------------------
# Redaction - applied to EVERY string we emit.
# ---------------------------------------------------------------------------

# The Windows username can appear in many forms inside paths/JSON: the bare name,
# C:\Users\<name>\..., or a forward-slash variant. Redact all of them to <USER>.
$script:UserName = $env:USERNAME
if ([string]::IsNullOrWhiteSpace($script:UserName)) {
    $script:UserName = [Environment]::UserName
}

function Protect-Text {
    <#
      Replace the Windows username with <USER> everywhere it appears. Case-
      insensitive. Also collapses the well-known C:\Users\<name> prefix so that
      even an unexpected username form is caught. Always returns a string.
    #>
    param([Parameter(ValueFromPipeline = $true)] $Text)

    process {
        if ($null -eq $Text) { return "" }
        $s = [string]$Text

        # 1) C:\Users\<anything-but-a-separator>  ->  C:\Users\<USER>
        #    Catches the username inside any user-profile path even if it differs
        #    from $env:USERNAME (e.g. a renamed profile folder).
        $s = [regex]::Replace($s, '([A-Za-z]:[\\/]+Users[\\/]+)[^\\/"]+', '${1}<USER>')

        # 2) The literal current username anywhere else (JSON values, env echoes).
        if (-not [string]::IsNullOrWhiteSpace($script:UserName)) {
            $escaped = [regex]::Escape($script:UserName)
            $s = [regex]::Replace($s, $escaped, '<USER>', 'IgnoreCase')
        }
        return $s
    }
}

# ---------------------------------------------------------------------------
# Report buffer + redacted emit helpers.
# ---------------------------------------------------------------------------

$script:Report = New-Object System.Text.StringBuilder

function Add-Line {
    # Every line that lands in the report passes through Protect-Text here, so a
    # caller can never accidentally emit an un-redacted string.
    param([string] $Text = "")
    [void]$script:Report.AppendLine((Protect-Text $Text))
}

function Add-Section {
    param([string] $Title)
    Add-Line ""
    Add-Line ("=" * 70)
    Add-Line ("  " + $Title)
    Add-Line ("=" * 70)
}

function Format-Size {
    # Human-ish byte size; never throws on $null.
    param($Bytes)
    if ($null -eq $Bytes) { return "?" }
    try {
        $b = [double]$Bytes
        if ($b -ge 1MB) { return ("{0:N2} MB" -f ($b / 1MB)) }
        if ($b -ge 1KB) { return ("{0:N2} KB" -f ($b / 1KB)) }
        return ("{0} bytes" -f [long]$b)
    } catch { return "?" }
}

function Report-FileStatus {
    <#
      Emit a uniform exists/size/last-write block for one file. Used for the DB,
      Game.log, etc. NEVER reads file contents.
    #>
    param([string] $Label, [string] $Path)
    if ([string]::IsNullOrWhiteSpace($Path)) {
        Add-Line ("{0}: (no path)" -f $Label)
        return
    }
    try {
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            $fi = Get-Item -LiteralPath $Path -ErrorAction Stop
            Add-Line ("{0}: EXISTS" -f $Label)
            Add-Line ("    path        : {0}" -f $Path)
            Add-Line ("    size        : {0}" -f (Format-Size $fi.Length))
            Add-Line ("    last-write  : {0}" -f $fi.LastWriteTime.ToString("u"))
        } else {
            Add-Line ("{0}: not found" -f $Label)
            Add-Line ("    path        : {0}" -f $Path)
        }
    } catch {
        Add-Line ("{0}: error reading status ({1})" -f $Label, $_.Exception.Message)
    }
}

# ---------------------------------------------------------------------------
# Paths.
# ---------------------------------------------------------------------------

$UserDataDir = Join-Path $env:APPDATA "sc-cargo-tracker"
$SettingsPath = Join-Path $UserDataDir "settings.json"
$AppInfoPath  = Join-Path $UserDataDir "app-info.json"
$DbPath       = Join-Path $UserDataDir "sc-cargo-tracker.db"
$LogPath      = Join-Path $UserDataDir "logs\main.log"
$LogRotated   = Join-Path $UserDataDir "logs\main.log.1"
$DefaultGameLog = "C:\Program Files\Roberts Space Industries\StarCitizen\LIVE\Game.log"

# ---------------------------------------------------------------------------
# Header.
# ---------------------------------------------------------------------------

Add-Line "SC Cargo Tracker - Diagnostics Report"
Add-Line ("Generated: {0}" -f (Get-Date).ToString("u"))
Add-Line ""
Add-Line "NOTICE: Review this file before sharing. Paths are redacted to <USER>,"
Add-Line "but double-check for anything sensitive. It contains NO Game.log contents."

# ---------------------------------------------------------------------------
# System.
# ---------------------------------------------------------------------------

Add-Section "System"
try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    Add-Line ("OS          : {0}" -f $os.Caption)
    Add-Line ("Version     : {0} (build {1})" -f $os.Version, $os.BuildNumber)
} catch {
    # Fall back to [Environment] if CIM isn't available.
    Add-Line ("OS          : {0}" -f [Environment]::OSVersion.VersionString)
}
Add-Line ("Architecture: {0}" -f $env:PROCESSOR_ARCHITECTURE)
Add-Line ("PowerShell  : {0}" -f $PSVersionTable.PSVersion.ToString())
Add-Line ("Machine     : (redacted)")
Add-Line ("Local time  : {0}" -f (Get-Date).ToString("u"))

# ---------------------------------------------------------------------------
# App info (app-info.json).
# ---------------------------------------------------------------------------

Add-Section "App Info (app-info.json)"
if (Test-Path -LiteralPath $AppInfoPath -PathType Leaf) {
    try {
        $raw = Get-Content -LiteralPath $AppInfoPath -Raw -ErrorAction Stop
        # Pretty-print via round-trip so an oddly-formatted file is normalized;
        # fall back to the raw text if parsing fails.
        try {
            $obj = $raw | ConvertFrom-Json -ErrorAction Stop
            Add-Line ($obj | ConvertTo-Json -Depth 6)
        } catch {
            Add-Line $raw
        }
    } catch {
        Add-Line ("Could not read app-info.json: {0}" -f $_.Exception.Message)
    }
} else {
    Add-Line "app-info.json not found - the app hasn't run yet (or uses a different data dir)."
}

# ---------------------------------------------------------------------------
# Settings (settings.json) - pretty, redacted.
# ---------------------------------------------------------------------------

Add-Section "Settings (settings.json)"
$configuredGameLog = $null
if (Test-Path -LiteralPath $SettingsPath -PathType Leaf) {
    try {
        $raw = Get-Content -LiteralPath $SettingsPath -Raw -ErrorAction Stop
        # Strip a leading UTF-8 BOM (U+FEFF) so ConvertFrom-Json doesn't choke
        # (matches the app's settings loader). Built from the code point so this
        # script stays pure-ASCII on disk.
        $raw = $raw -replace ("^" + [char]0xFEFF), ""
        try {
            $settings = $raw | ConvertFrom-Json -ErrorAction Stop
            Add-Line ($settings | ConvertTo-Json -Depth 6)
            # Derive the configured Game.log path for the next section.
            if ($settings.PSObject.Properties.Name -contains "gameLogPath" -and $settings.gameLogPath) {
                $configuredGameLog = [string]$settings.gameLogPath
            } elseif ($settings.PSObject.Properties.Name -contains "liveFolder" -and $settings.liveFolder) {
                $configuredGameLog = Join-Path ([string]$settings.liveFolder) "Game.log"
            }
        } catch {
            Add-Line "(settings.json present but not valid JSON - raw contents below)"
            Add-Line $raw
        }
    } catch {
        Add-Line ("Could not read settings.json: {0}" -f $_.Exception.Message)
    }
} else {
    Add-Line "settings.json not found - no custom LIVE folder configured (app uses the default path)."
}

# ---------------------------------------------------------------------------
# Game.log status (configured + default). NO CONTENTS - status only.
# ---------------------------------------------------------------------------

Add-Section "Game.log Status (file status only - NO contents collected)"

if ($configuredGameLog) {
    Report-FileStatus "Configured Game.log" $configuredGameLog
} else {
    Add-Line "Configured Game.log: (none configured in settings)"
}
Add-Line ""
Report-FileStatus "Default Game.log" $DefaultGameLog

# logbackups count for whichever Game.log directory we know about.
Add-Line ""
$backupRoots = @()
if ($configuredGameLog) { $backupRoots += (Join-Path (Split-Path -Parent $configuredGameLog) "logbackups") }
$backupRoots += (Join-Path (Split-Path -Parent $DefaultGameLog) "logbackups")
foreach ($bk in ($backupRoots | Select-Object -Unique)) {
    try {
        if (Test-Path -LiteralPath $bk -PathType Container) {
            $logs = @(Get-ChildItem -LiteralPath $bk -Filter "*.log" -File -ErrorAction SilentlyContinue)
            Add-Line ("logbackups: {0} - {1} *.log file(s)" -f $bk, $logs.Count)
        } else {
            Add-Line ("logbackups: {0} - not found" -f $bk)
        }
    } catch {
        Add-Line ("logbackups: {0} - error ({1})" -f $bk, $_.Exception.Message)
    }
}

# ---------------------------------------------------------------------------
# Database.
# ---------------------------------------------------------------------------

Add-Section "Database"
Report-FileStatus "sc-cargo-tracker.db" $DbPath
Add-Line ""
# WAL/SHM sidecars present?
foreach ($sc in @("-wal", "-shm")) {
    $p = $DbPath + $sc
    if (Test-Path -LiteralPath $p -PathType Leaf) {
        try {
            $fi = Get-Item -LiteralPath $p -ErrorAction Stop
            Add-Line ("sidecar {0}: present ({1})" -f $sc, (Format-Size $fi.Length))
        } catch {
            Add-Line ("sidecar {0}: present" -f $sc)
        }
    } else {
        Add-Line ("sidecar {0}: absent" -f $sc)
    }
}
Add-Line ""
# Corruption history: any quarantined *.corrupt-* files.
try {
    $corrupt = @(Get-ChildItem -LiteralPath $UserDataDir -Filter "*.corrupt-*" -File -ErrorAction SilentlyContinue)
    if ($corrupt.Count -gt 0) {
        Add-Line ("Corruption history: {0} quarantined file(s) found:" -f $corrupt.Count)
        foreach ($c in $corrupt) {
            Add-Line ("    {0}  ({1}, {2})" -f $c.Name, (Format-Size $c.Length), $c.LastWriteTime.ToString("u"))
        }
    } else {
        Add-Line "Corruption history: none (no *.corrupt-* files)."
    }
} catch {
    Add-Line ("Corruption history: error scanning ({0})" -f $_.Exception.Message)
}

# ---------------------------------------------------------------------------
# App log (tail of main.log) - redacted, contents-bounded.
# ---------------------------------------------------------------------------

Add-Section "App Log (logs\main.log - last ~400 lines, redacted)"
if (Test-Path -LiteralPath $LogPath -PathType Leaf) {
    if (Test-Path -LiteralPath $LogRotated -PathType Leaf) {
        Add-Line "(an older rotation main.log.1 also exists; only main.log is included below)"
        Add-Line ""
    }
    try {
        $tail = Get-Content -LiteralPath $LogPath -Tail 400 -ErrorAction Stop
        if ($null -eq $tail) { $tail = @() }
        Add-Line ("--- main.log (last {0} line(s)) ---" -f @($tail).Count)
        foreach ($l in $tail) { Add-Line $l }
        Add-Line "--- end of main.log ---"
    } catch {
        Add-Line ("Could not read main.log: {0}" -f $_.Exception.Message)
    }
} else {
    Add-Line "logs\main.log not found - the app hasn't produced a log yet."
}

# ---------------------------------------------------------------------------
# userData directory listing - redacted.
# ---------------------------------------------------------------------------

Add-Section "userData Directory Listing"
Add-Line ("dir: {0}" -f $UserDataDir)
Add-Line ""
if (Test-Path -LiteralPath $UserDataDir -PathType Container) {
    try {
        $items = Get-ChildItem -LiteralPath $UserDataDir -Force -ErrorAction Stop |
                 Sort-Object PSIsContainer, Name
        foreach ($it in $items) {
            if ($it.PSIsContainer) {
                Add-Line ("  [DIR]  {0,-40} {1}" -f $it.Name, $it.LastWriteTime.ToString("u"))
            } else {
                Add-Line ("  {0,-47} {1,12}  {2}" -f $it.Name, (Format-Size $it.Length), $it.LastWriteTime.ToString("u"))
            }
        }
    } catch {
        Add-Line ("Could not list userData: {0}" -f $_.Exception.Message)
    }
} else {
    Add-Line "userData directory not found - the app may never have run on this machine."
}

# ---------------------------------------------------------------------------
# Footer.
# ---------------------------------------------------------------------------

Add-Section "End of Report"
Add-Line "NOTICE: Review this file before sharing - paths are redacted to <USER>"
Add-Line "but double-check for anything sensitive. It contains NO Game.log contents."

# ---------------------------------------------------------------------------
# Write to Desktop.
# ---------------------------------------------------------------------------

$stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
$fileName = "sc-tracker-diagnostics-$stamp.txt"

# Resolve the Desktop robustly; fall back to the profile root, then temp.
$desktop = $null
try { $desktop = [Environment]::GetFolderPath("Desktop") } catch { $desktop = $null }
if ([string]::IsNullOrWhiteSpace($desktop) -or -not (Test-Path -LiteralPath $desktop -PathType Container)) {
    $desktop = $env:USERPROFILE
}
if ([string]::IsNullOrWhiteSpace($desktop) -or -not (Test-Path -LiteralPath $desktop -PathType Container)) {
    $desktop = $env:TEMP
}

$outPath = Join-Path $desktop $fileName
try {
    Set-Content -LiteralPath $outPath -Value $script:Report.ToString() -Encoding UTF8 -ErrorAction Stop
    Write-Host ""
    Write-Host "Diagnostics report written to:" -ForegroundColor Green
    Write-Host "  $outPath"
    Write-Host ""
    Write-Host "Review it (paths are redacted to <USER>; it contains no Game.log contents),"
    Write-Host "then attach it when reporting your issue."
} catch {
    Write-Host "Failed to write the report to '$outPath': $($_.Exception.Message)" -ForegroundColor Red
    # Last-ditch: dump to the console so the data isn't lost.
    Write-Host "----- BEGIN REPORT (console fallback) -----"
    Write-Host $script:Report.ToString()
    Write-Host "----- END REPORT -----"
}

