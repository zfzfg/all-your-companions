<#
.SYNOPSIS
    Aktualisiert die Versionsnummer von "All your Companions" ueberall im Projekt.

.DESCRIPTION
    Liest die aktuelle Versionsnummer automatisch aus package.json und traegt
    die neue Versionsnummer an allen relevanten Stellen ein:
      1. package.json              ("version": "X.Y.Z")
      2. package-lock.json         (Root- & Packages[""]-Version, keine Dependencies)
      3. media/settings.js         (ABOUT_DISCLAIMER: "All your Companions vX.Y.Z")
      4. src/sidebar.ts            (Fallback: extensionVersion ?? "X.Y.Z")
      5. scripts/ui-harness/run.mjs (initialState: extVersion: "X.Y.Z")
      6. CHANGELOG.md              (Neuer Release-Abschnitt ## [X.Y.Z] - YYYY-MM-DD)

.PARAMETER NewVersion
    Die neue Versionsnummer (z. B. 0.3.2). Wenn nicht angegeben, wird interaktiv gefragt.

.PARAMETER ChangelogAction
    Wie CHANGELOG.md behandelt werden soll:
      - AddNew:        Fuegt '## [X.Y.Z] - YYYY-MM-DD' unter ## Unreleased ein (Standard)
      - ReplaceLatest: Ersetzt die vorherige Versions-Ueberschrift durch die neue
      - Skip:          Aendert CHANGELOG.md nicht

.PARAMETER DryRun
    Simuliert die Aenderungen und zeigt die Treffer an, ohne Dateien zu schreiben.

.PARAMETER ShowDiff
    Fuehrt nach dem Update 'git diff' aus, um alle Aenderungen direkt zu pruefen.

.PARAMETER Compile
    Fuehrt nach erfolgreicher Aenderung 'npm run compile' aus.

.EXAMPLE
    pwsh scripts\bump-version.ps1
.EXAMPLE
    pwsh scripts\bump-version.ps1 -NewVersion 0.3.2
.EXAMPLE
    pwsh scripts\bump-version.ps1 -NewVersion 0.3.2 -DryRun
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Position = 0)]
    [string]$NewVersion,

    [Parameter()]
    [ValidateSet("AddNew", "ReplaceLatest", "Skip")]
    [string]$ChangelogAction,

    [Parameter()]
    [switch]$DryRun,

    [Parameter()]
    [switch]$ShowDiff,

    [Parameter()]
    [switch]$Compile
)

$ErrorActionPreference = "Stop"

# 1. Ermitteln des Projektverzeichnisses (egal von wo aufgerufen wird)
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }

$repoRoot = $scriptDir
if (Test-Path (Join-Path $scriptDir "package.json")) {
    $repoRoot = $scriptDir
} elseif (Test-Path (Join-Path $scriptDir "..\package.json")) {
    $repoRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path
} elseif (Test-Path (Join-Path $scriptDir "grok-build-vscode\package.json")) {
    $repoRoot = (Resolve-Path (Join-Path $scriptDir "grok-build-vscode")).Path
} else {
    throw "Projektverzeichnis konnte nicht gefunden werden (package.json fehlt)."
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# 2. Aktuelle Version aus package.json auslesen
$packageJsonPath = Join-Path $repoRoot "package.json"
$packageContent = [System.IO.File]::ReadAllText($packageJsonPath, [System.Text.Encoding]::UTF8)
$pkgJson = $packageContent | ConvertFrom-Json
$currentVersion = $pkgJson.version

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   All your Companions - Versionsaktualisierung" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Projektverzeichnis : $repoRoot" -ForegroundColor DarkGray
Write-Host "Aktuelle Version   : $currentVersion" -ForegroundColor Yellow

# 3. Neue Version ermitteln / abfragen
if (-not $NewVersion) {
    while (-not $NewVersion) {
        $inputVersion = Read-Host "`nNeue Versionsnummer eingeben (z. B. 0.3.2)"
        if ($inputVersion) {
            $NewVersion = $inputVersion.Trim()
        }
    }
} else {
    $NewVersion = $NewVersion.Trim()
}

# Bereinigen, falls versehentlich mit führendem 'v' eingegeben wurde
if ($NewVersion -match '^v(\d+\..*)$') {
    $NewVersion = $matches[1]
}

# Validierung SemVer-Format
if ($NewVersion -notmatch '^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$') {
    throw "Ungueltiges Versionsformat: '$NewVersion'. Erwartet wird SemVer (z. B. 0.3.2 oder 0.4.0-beta.1)."
}

if ($NewVersion -eq $currentVersion) {
    Write-Host "`nDie angegebene Version ($NewVersion) entspricht bereits der aktuellen Version. Keine Aenderungen erforderlich." -ForegroundColor Yellow
    return
}

Write-Host "Ziel-Version       : $NewVersion" -ForegroundColor Green
if ($WhatIfPreference) {
    $DryRun = $true
}
if ($DryRun) {
    Write-Host "MODUS              : DRY-RUN (Es werden KEINE Dateien ueberschrieben)" -ForegroundColor Magenta
}

# 4. Changelog-Aktion ermitteln
$today = (Get-Date).ToString("yyyy-MM-dd")
if (-not $ChangelogAction) {
    if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
        Write-Host "`nWie soll CHANGELOG.md aktualisiert werden?" -ForegroundColor Cyan
        Write-Host "  [1] Neuen Release-Abschnitt '## [$NewVersion] - $today' anlegen (Standard)"
        Write-Host "  [2] Letzten Abschnitt '## [$currentVersion]' durch '## [$NewVersion] - $today' ersetzen"
        Write-Host "  [3] CHANGELOG.md unverändert lassen"
        $choice = Read-Host "Auswahl [1/2/3] (Standard: 1)"
        switch ($choice.Trim()) {
            "2"     { $ChangelogAction = "ReplaceLatest" }
            "3"     { $ChangelogAction = "Skip" }
            default { $ChangelogAction = "AddNew" }
        }
    } else {
        $ChangelogAction = "AddNew"
    }
}
Write-Host "Changelog-Aktion   : $ChangelogAction" -ForegroundColor DarkGray
Write-Host ""

$rep = '${1}' + $NewVersion + '${2}'
$changedCount = 0

# Helper: Aenderungen anzeigen / schreiben
function Update-FileContent {
    param(
        [string]$FilePath,
        [string]$Description,
        [scriptblock]$Transform
    )
    $relPath = Resolve-Path -Relative $FilePath
    if (-not (Test-Path $FilePath)) {
        Write-Host "  [FEHLT] $relPath ($Description)" -ForegroundColor Red
        return
    }

    $original = [System.IO.File]::ReadAllText($FilePath, [System.Text.Encoding]::UTF8)
    $updated = & $Transform $original

    if ($original -ne $updated) {
        if ($DryRun) {
            Write-Host "  [DRY-RUN] Wuerde aktualisieren: $relPath ($Description)" -ForegroundColor Magenta
        } else {
            [System.IO.File]::WriteAllText($FilePath, $updated, $utf8NoBom)
            Write-Host "  [OK] Aktualisiert: $relPath ($Description)" -ForegroundColor Green
        }
        $script:changedCount++
    } else {
        Write-Host "  [--] Keine Aenderung noetig / Muster nicht gefunden: $relPath ($Description)" -ForegroundColor DarkGray
    }
}

# --- 1. package.json ---
Update-FileContent -FilePath (Join-Path $repoRoot "package.json") -Description "Extension-Manifest" -Transform {
    param($content)
    [regex]::Replace($content, '("version"\s*:\s*")' + [regex]::Escape($currentVersion) + '(")', $rep, 1)
}

# --- 2. package-lock.json ---
Update-FileContent -FilePath (Join-Path $repoRoot "package-lock.json") -Description "NPM Lockfile" -Transform {
    param($content)
    # Ersetzt Root-Paket und packages[""], ruehrt keine abhaengigen Pakete an
    $patLock = '("name"\s*:\s*"all-your-companions",\s*\r?\n\s*"version"\s*:\s*")' + [regex]::Escape($currentVersion) + '(")'
    [regex]::Replace($content, $patLock, $rep)
}

# --- 3. media/settings.js ---
Update-FileContent -FilePath (Join-Path $repoRoot "media\settings.js") -Description "Settings UI Disclaimer" -Transform {
    param($content)
    $patSettings = '("All your Companions v)' + [regex]::Escape($currentVersion) + '(\s)'
    [regex]::Replace($content, $patSettings, $rep)
}

# --- 4. src/sidebar.ts ---
Update-FileContent -FilePath (Join-Path $repoRoot "src\sidebar.ts") -Description "Sidebar Context Fallback" -Transform {
    param($content)
    $patSidebar = '(extensionVersion\s*\?\?\s*")' + [regex]::Escape($currentVersion) + '(")'
    [regex]::Replace($content, $patSidebar, $rep)
}

# --- 5. scripts/ui-harness/run.mjs ---
Update-FileContent -FilePath (Join-Path $repoRoot "scripts\ui-harness\run.mjs") -Description "UI Harness Mock State" -Transform {
    param($content)
    $patHarness = '(extVersion\s*:\s*")' + [regex]::Escape($currentVersion) + '(")'
    [regex]::Replace($content, $patHarness, $rep)
}

# --- 6. CHANGELOG.md ---
if ($ChangelogAction -ne "Skip") {
    Update-FileContent -FilePath (Join-Path $repoRoot "CHANGELOG.md") -Description "Changelog ($ChangelogAction)" -Transform {
        param($content)
        if ($ChangelogAction -eq "ReplaceLatest") {
            # Ersetzt ## [0.3.1] - Datum durch ## [0.3.2] - Datum
            $patOldSection = '##\s+\[' + [regex]::Escape($currentVersion) + '\](\s*-\s*[^\r\n]*)?'
            $newSection = "## [$NewVersion] - $today"
            return [regex]::Replace($content, $patOldSection, $newSection, 1)
        } else {
            # AddNew: Prueft ob die Version schon drin ist
            if ($content -match ('##\s*\[' + [regex]::Escape($NewVersion) + '\]')) {
                return $content
            }
            # Fuegt ## [NewVersion] - Datum direkt unter ## Unreleased ein
            $patUnreleased = '(##\s+Unreleased\s*\r?\n\s*)'
            $newEntry = "`$1## [$NewVersion] - $today`r`n`r`n"
            return [regex]::Replace($content, $patUnreleased, $newEntry, 1)
        }
    }
}

Write-Host ""
if ($DryRun) {
    Write-Host "Dry-Run abgeschlossen: $changedCount Dateien wuerden angepasst werden." -ForegroundColor Magenta
} else {
    Write-Host "Erfolgreich: $changedCount Dateien auf Version $NewVersion aktualisiert!" -ForegroundColor Green

    if ($ShowDiff) {
        Write-Host "`nGit Diff:" -ForegroundColor Cyan
        git diff
    }

    if ($Compile) {
        Write-Host "`nFuehre 'npm run compile' aus..." -ForegroundColor Cyan
        Push-Location $repoRoot
        try {
            npm run compile
        } finally {
            Pop-Location
        }
    } else {
        Write-Host "`nNaechste Schritte:" -ForegroundColor DarkGray
        Write-Host "  1. npm run compile              (Kompilieren und pruefen)" -ForegroundColor DarkGray
        Write-Host "  2. pwsh scripts\install.ps1     (Frische VSIX bauen und lokal installieren)" -ForegroundColor DarkGray
        Write-Host "  3. pwsh scripts\release.ps1     (Kompletter Release-Workflow mit Tests)" -ForegroundColor DarkGray
    }
}
Write-Host ""
