<#
.SYNOPSIS
  A.I.M. development bootstrap for Windows (PowerShell 5.1 or 7+).
.DESCRIPTION
  Installs dependencies, builds the library packages the Electron app imports
  (shared, core, tools-mcp, extension), then starts the desktop app with electron-vite dev.
#>
$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $Root

function Require-Command($name, $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Write-Error "'$name' is required but was not found on PATH. $hint"
  }
}

Require-Command node 'Install Node.js 20 or newer from https://nodejs.org/.'
$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 20) { Write-Error "Node.js 20 or newer is required (found $(node --version))." }

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  if (Get-Command corepack -ErrorAction SilentlyContinue) {
    Write-Host 'pnpm not found; enabling it through corepack.'
    corepack enable
  } else {
    Write-Error "pnpm is required. Install it with 'npm install -g pnpm'."
  }
}

Write-Host '== Installing dependencies'
pnpm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '== Building shared, core, tools-mcp and the browser extension'
foreach ($step in 'build:shared', 'build:core', 'build:tools-mcp', 'build:extension') {
  pnpm $step
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (-not (Test-Path 'assets/icons/icon.png')) {
  Write-Host '== Generating icons'
  node scripts/generate-icons.mjs
}

Write-Host '== Checking the Claude Code CLI (non-fatal)'
& (Join-Path $PSScriptRoot 'check-claude-cli.ps1')
if ($LASTEXITCODE -ne 0) { Write-Warning 'Fix the Claude CLI before starting a chat; the app will still launch.' }

Write-Host '== Starting A.I.M. in development mode'
pnpm dev
exit $LASTEXITCODE
