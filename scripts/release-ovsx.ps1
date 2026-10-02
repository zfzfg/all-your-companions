<#
.SYNOPSIS
    Veroeffentlicht die aktuelle Version auf Open VSX (ohne GitHub-Schritte).

.DESCRIPTION
    Prueft das Vorhandensein des OVSX-Authentifizierungs-Tokens im Environment,
    stellt sicher, dass die aktuelle VSIX-Datei gebaut ist, und veroeffentlicht
    sie mittels 'npm run publish:ovsx' ausschliesslich auf Open VSX.
    Es werden KEINE Git-Commits, Tags oder GitHub Releases ausgefuehrt.

.PARAMETER Force
    Ueberspringt die Bestaetigungsabfrage vor dem Upload.

.EXAMPLE
    pwsh scripts\release-ovsx.ps1
.EXAMPLE
    pwsh scripts\release-ovsx.ps1 -Force
#>
[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# 1. Version aus package.json lesen
$pkg = Get-Content (Join-Path $repoRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $pkg.version
$vsixName = "all-your-companions-$version.vsix"
$vsixPath = Join-Path $repoRoot $vsixName

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Open VSX Release: $vsixName" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Version       : $version" -ForegroundColor Yellow
Write-Host "VSIX-Datei    : $vsixName" -ForegroundColor DarkGray
Write-Host "Ziel-Registry : Open VSX (https://open-vsx.org/extension/zfzfg/all-your-companions)" -ForegroundColor DarkGray
Write-Host "Hinweis       : Reines Open-VSX-Release (OHNE GitHub Commit/Tag/Release)" -ForegroundColor DarkCyan
Write-Host ""

# 2. Token-Pruefung
$tokenFound = $false
if ($env:OVSX_PAT -or $env:OPEN_VSX_API_KEY) {
    $tokenFound = $true
} elseif (Test-Path (Join-Path $repoRoot ".env")) {
    $envLines = Get-Content (Join-Path $repoRoot ".env")
    foreach ($line in $envLines) {
        if ($line -match '^\s*OPEN_VSX_API_KEY\s*=\s*(.+)$') {
            $tokenFound = $true
            break
        }
    }
}

if (-not $tokenFound) {
    Write-Host "[FEHLER] Kein Open VSX Authentifizierungs-Token gefunden!" -ForegroundColor Red
    Write-Host "Bitte setze die Umgebungsvariable 'OVSX_PAT' oder trage 'OPEN_VSX_API_KEY' in .env ein." -ForegroundColor Red
    exit 1
} else {
    Write-Host "[OK] Open VSX Auth-Token im Environment erkannt." -ForegroundColor Green
}

# 3. VSIX-Datei pruefen / ggf. bauen
if (-not (Test-Path $vsixPath)) {
    Write-Host "`nDie Datei '$vsixName' existiert noch nicht im Projektverzeichnis." -ForegroundColor Yellow
    $buildChoice = Read-Host "Soll 'npm run package' jetzt ausgefuehrt werden? [J/n]"
    if ($buildChoice -and $buildChoice.Trim().ToLower() -eq "n") {
        Write-Host "Abbruch. Bitte baue die VSIX zuerst mit Option [3]." -ForegroundColor Red
        exit 1
    }
    Write-Host "Baue Paket..." -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot "package.ps1")
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $vsixPath)) {
        Write-Host "[FEHLER] Paketierung fehlgeschlagen." -ForegroundColor Red
        exit 1
    }
}

# 4. Bestaetigung
if (-not $Force) {
    Write-Host ""
    $confirm = Read-Host "Moechtest du Version $version jetzt wirklich auf Open VSX veroeffentlichen? [j/N]"
    if (-not $confirm -or $confirm.Trim().ToLower() -ne "j") {
        Write-Host "Veroeffentlichung abgebrochen." -ForegroundColor Yellow
        exit 0
    }
}

# 5. Upload durchfuehren
Write-Host "`n==> Veroeffentliche auf Open VSX (npm run publish:ovsx)..." -ForegroundColor Cyan
$ErrorActionPreference = "Continue"
npm run publish:ovsx
$exitCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"

if ($exitCode -eq 0) {
    Write-Host "`n==========================================================" -ForegroundColor Green
    Write-Host "   [ERFOLG] Version $version wurde auf Open VSX veroeffentlicht!" -ForegroundColor Green
    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host "Listing: https://open-vsx.org/extension/zfzfg/all-your-companions`n" -ForegroundColor Cyan
} else {
    Write-Host "`n[FEHLER] Upload auf Open VSX fehlgeschlagen (Exit-Code $exitCode)." -ForegroundColor Red
    exit $exitCode
}
