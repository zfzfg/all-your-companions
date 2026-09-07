# Install the All your Companions VS Code extension on Windows.
# Usage:  pwsh scripts\install.ps1 [-VsixPath path\to.vsix] [-Cli name-or-path] [-All]
#   -Cli  - a code-compatible CLI to install into (e.g. code-insiders, cursor,
#           antigravity, C:\path\to\code.cmd); also settable via $env:CODE_CLI.
#           Default: auto-detect code -> code-insiders -> cursor -> antigravity-ide -> antigravity.
#   -All  - install into EVERY detected known CLI in one run (build once, install N times).
#
# Always builds a FRESH .vsix from the current source (npm run package clears the
# stale one first) unless an explicit -VsixPath is given - so an install never
# silently ships a leftover build. Uses --force so a same-version reinstall overwrites.
#
# This fork has no relay, so a local build is just a build: upstream's
# staging/production URL swap around every `npm run package` is gone with it.

param(
    [string]$VsixPath,
    [string]$Cli,
    [switch]$All
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$knownClis = @("code", "code-insiders", "cursor", "antigravity-ide", "antigravity")
if (-not $Cli -and $env:CODE_CLI) { $Cli = $env:CODE_CLI }
if ($All -and $Cli) { throw "-All and -Cli are mutually exclusive." }


if (-not $VsixPath) {
    Write-Host ""
    Write-Host "Building a fresh .vsix from current source..."
    Push-Location $repoRoot
    $beforeVsix = @()
    try {
        # npm writes to stderr for things that are not failures. Under
        # $ErrorActionPreference = "Stop", Windows PowerShell 5.1 turns any
        # native-command stderr into a terminating error, so a build could abort
        # on its own progress output. (pwsh 7 does not, which is why the
        # documented `pwsh scripts\install.ps1` invocation never hit it.)
        #
        # PS 5.1 also leaves $LASTEXITCODE unchanged when command *resolution*
        # fails. If npm is missing, both exit-code checks would pass and the
        # leftover *.vsix would be installed under a "fresh build" banner.
        if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
            throw "npm is not on PATH. Install Node.js, then re-run."
        }
        $beforeVsix = @(Get-ChildItem -Path $repoRoot -Filter "*.vsix" -ErrorAction SilentlyContinue | ForEach-Object {
            [pscustomobject]@{ Path = $_.FullName; Ticks = $_.LastWriteTimeUtc.Ticks; Length = $_.Length }
        })
        $ErrorActionPreference = "Continue"
        if (-not (Test-Path "node_modules")) {
            npm install
            if ($LASTEXITCODE) { $ErrorActionPreference = "Stop"; throw "npm install failed (exit $LASTEXITCODE)" }
        }
        npm run package   # prepackage clears every *.vsix and wipes out/, then builds
        $packageExit = $LASTEXITCODE
        $ErrorActionPreference = "Stop"
        if ($packageExit) { throw "npm run package failed (exit $packageExit)" }
        $vsix = Get-ChildItem -Path $repoRoot -Filter "*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    } finally {
        Pop-Location
    }
    if (-not $vsix) { throw "Build did not produce a .vsix." }
    $unchanged = $beforeVsix | Where-Object {
        $_.Path -eq $vsix.FullName -and $_.Ticks -eq $vsix.LastWriteTimeUtc.Ticks -and $_.Length -eq $vsix.Length
    }
    if ($unchanged) {
        throw "npm run package did not produce a new .vsix (refusing to install a leftover build)."
    }
    $VsixPath = $vsix.FullName
}

function Find-KnownClis {
    $found = @()
    foreach ($name in $knownClis) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) { $found += $cmd.Source }
    }
    return $found
}

function Find-CodeCli {
    if ($Cli) {
        $cmd = Get-Command $Cli -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
        if (Test-Path $Cli) { return $Cli }
        throw "Requested CLI not found: $Cli"
    }
    foreach ($name in $knownClis) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    }
    foreach ($fallback in @(
        "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
        "$env:LOCALAPPDATA\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd",
        "$env:LOCALAPPDATA\Programs\cursor\resources\app\bin\cursor.cmd"
    )) {
        if (Test-Path $fallback) { return $fallback }
    }
    throw "Could not find a code-compatible CLI. Install VS Code, or pass one: pwsh scripts\install.ps1 -Cli <name-or-path>"
}

if ($All) {
    $targets = Find-KnownClis
    if (-not $targets) { throw "No known code-compatible CLI detected ($($knownClis -join ', '))." }
} else {
    $targets = @(Find-CodeCli)
}

# The editor CLIs print a Node deprecation warning to stderr. Under
# $ErrorActionPreference = "Stop" that becomes a TERMINATING error, so -All used
# to install into the first editor and stop - leaving the others silently on the
# previous version while the run looked like it had failed outright. Exit codes
# are the truth here, not stderr.
$installed = @()
$failed = @()
foreach ($code in $targets) {
    Write-Host "Installing $VsixPath via $code"
    $ErrorActionPreference = "Continue"
    & $code --install-extension $VsixPath --force 2>&1 | ForEach-Object { Write-Host "  $_" }
    $exit = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    if ($exit -eq 0) { $installed += $code } else { $failed += "$code (exit $exit)" }
}

Write-Host ""
Write-Host "  Installed into: $($installed -join ', ')" -ForegroundColor Green
if ($failed) { Write-Host "  FAILED: $($failed -join ', ')" -ForegroundColor Red }
Write-Host ""
Write-Host "Reload the IDE window (Ctrl+Shift+P -> 'Developer: Reload Window') and open Companions (Ctrl+;)."

if (-not $Cli -and -not $All) {
    $chosen = [System.IO.Path]::GetFileNameWithoutExtension($targets[0])
    $others = $knownClis | Where-Object { $_ -ne $chosen -and (Get-Command $_ -ErrorAction SilentlyContinue) }
    if ($others) {
        Write-Host "Also detected: $($others -join ', ') - to install there instead: pwsh scripts\install.ps1 -Cli <name> (or -All for every detected IDE)"
    }
}
