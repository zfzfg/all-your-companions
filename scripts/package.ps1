<#
.SYNOPSIS
    Baut das VSIX-Paket fuer All your Companions.

.DESCRIPTION
    Raeumt alte VSIX-Dateien auf, kompiliert und verpackt die Extension
    mittels 'npm run package'. Kopiert die fertige VSIX zusaetzlich in den
    Workspace-Root, damit sie direkt greifbar ist.
#>
[CmdletBinding()]
param(
    [switch]$NoCopyRoot
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $repoRoot
Set-Location $repoRoot

$pkg = Get-Content (Join-Path $repoRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $pkg.version
$vsixName = "all-your-companions-$version.vsix"
$vsixPath = Join-Path $repoRoot $vsixName

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Baue VSIX-Paket: $vsixName" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Projektverzeichnis : $repoRoot" -ForegroundColor DarkGray
Write-Host "Ziel-VSIX          : $vsixName`n" -ForegroundColor Yellow

Write-Host "==> Starte Paketierung (npm run package)..." -ForegroundColor Cyan
$ErrorActionPreference = "Continue"
npm run package
$exitCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"

if ($exitCode -ne 0) {
    Write-Host "`n[FEHLER] Paketierung fehlgeschlagen mit Exit-Code $exitCode" -ForegroundColor Red
    exit $exitCode
}

if (-not (Test-Path $vsixPath)) {
    Write-Host "`n[FEHLER] Die erwartete Datei '$vsixPath' wurde nicht gefunden!" -ForegroundColor Red
    exit 1
}

$fileInfo = Get-Item $vsixPath
$sizeMb = [math]::Round($fileInfo.Length / 1MB, 2)
Write-Host "`n[OK] VSIX erfolgreich erstellt!" -ForegroundColor Green
Write-Host "  Datei: $($fileInfo.FullName)" -ForegroundColor Green
Write-Host "  Groesse: $sizeMb MB ($($fileInfo.Length) Bytes)" -ForegroundColor DarkGray

# Optional: Kopie in den Root-Workspace legen
if (-not $NoCopyRoot -and (Test-Path $workspaceRoot)) {
    $destRootPath = Join-Path $workspaceRoot $vsixName
    Copy-Item -Path $vsixPath -Destination $destRootPath -Force
    Write-Host "  Kopie im Root: $destRootPath" -ForegroundColor DarkCyan
}

Write-Host ""
