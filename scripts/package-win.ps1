<#
.SYNOPSIS
  Build the Windows installer (NSIS) and the portable executable for A.I.M.
.DESCRIPTION
  Runs the full monorepo build, regenerates icons, then invokes electron-builder with
  --win. The result is written to packages/desktop/release/:
    AIM-Setup-<version>.exe     per-user NSIS installer (desktop + Start Menu shortcuts)
    AIM-Portable-<version>.exe  single-file portable build

  Must run on Windows (or under Wine on Linux/macOS, which is slower and not tested
  here): the NSIS toolchain and the native modules (better-sqlite3, nut-js) are built
  for the host platform. Native builds need the Visual Studio C++ Build Tools and
  Python 3 — "npm install -g windows-build-tools" is obsolete; install them from the
  Visual Studio Installer ("Desktop development with C++").

  The installer is unsigned. Windows SmartScreen will warn on first launch; see
  docs/TROUBLESHOOTING.md. To sign, set CSC_LINK / CSC_KEY_PASSWORD before running.
#>
param(
  [switch] $SkipInstall,
  [switch] $SkipTests
)
$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $Root

if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core' -and $env:OS -ne 'Windows_NT') {
  Write-Warning 'This script expects Windows. Under Wine use: pnpm dist:win (electron-builder will try to use Wine).'
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { Write-Error 'pnpm is required (npm install -g pnpm).' }

if (-not $SkipInstall) {
  Write-Host '== pnpm install'
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { pnpm install; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
}

Write-Host '== icons'
node scripts/generate-icons.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $SkipTests) {
  Write-Host '== tests'
  pnpm test
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host '== build + electron-builder --win'
# Do not try to code-sign unless a certificate was provided.
if (-not $env:CSC_LINK) { $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false' }
pnpm dist:win
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host 'Artifacts in packages/desktop/release:'
Get-ChildItem 'packages/desktop/release' -Filter '*.exe' | ForEach-Object { Write-Host ("  {0}  ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB)) }
