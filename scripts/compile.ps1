<#
.SYNOPSIS
    Kompiliert die All your Companions VS Code Extension.

.DESCRIPTION
    Fuehrt tsc und esbuild ueber 'npm run compile' aus und validiert
    die TypeScript-Syntax und Bundle-Erstellung.
#>
[CmdletBinding()]
param(
    [switch]$Typecheck
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$pkg = Get-Content (Join-Path $repoRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $pkg.version

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Kompiliere All your Companions (v$version)" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Projektverzeichnis: $repoRoot`n" -ForegroundColor DarkGray

Write-Host "==> npm run compile (tsc + esbuild + muse-adapter)" -ForegroundColor Cyan
$ErrorActionPreference = "Continue"
npm run compile
$exitCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"

if ($exitCode -ne 0) {
    Write-Host "`n[FEHLER] Kompilierung fehlgeschlagen mit Exit-Code $exitCode" -ForegroundColor Red
    exit $exitCode
}

if ($Typecheck) {
    Write-Host "`n==> npm run typecheck" -ForegroundColor Cyan
    $ErrorActionPreference = "Continue"
    npm run typecheck
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    if ($exitCode -ne 0) {
        Write-Host "`n[FEHLER] Typecheck fehlgeschlagen mit Exit-Code $exitCode" -ForegroundColor Red
        exit $exitCode
    }
}

Write-Host "`n[OK] Kompilierung erfolgreich abgeschlossen!" -ForegroundColor Green
Write-Host ""
