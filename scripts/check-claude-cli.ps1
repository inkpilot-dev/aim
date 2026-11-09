<#
.SYNOPSIS
  Verify that the Claude Code CLI is installed and logged in (Windows).
.DESCRIPTION
  A.I.M. drives the `claude` CLI and never stores an API key itself. This script finds the
  executable, prints its version and checks for an active login. Exit code 0 means ready.
#>
$ErrorActionPreference = 'Continue'
Write-Host 'Checking the Claude Code CLI'

$cli = $null
$cmd = Get-Command claude -ErrorAction SilentlyContinue
if ($cmd) { $cli = $cmd.Source }
if (-not $cli) {
  $candidates = @(
    (Join-Path $env:APPDATA 'npm\claude.cmd'),
    (Join-Path $env:USERPROFILE '.local\bin\claude.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\claude\claude.exe')
  )
  foreach ($c in $candidates) { if (Test-Path $c) { $cli = $c; break } }
}

if (-not $cli) {
  Write-Host "  [fail] 'claude' was not found on PATH." -ForegroundColor Red
  Write-Host '  Install it with one of:'
  Write-Host '    npm install -g @anthropic-ai/claude-code'
  Write-Host '    irm https://claude.ai/install.ps1 | iex        (native installer)'
  Write-Host '  then run `claude` once and sign in (Pro/Max subscription or Console account).'
  exit 1
}

$version = (& $cli --version 2>$null | Select-Object -First 1)
if (-not $version) {
  Write-Host "  [fail] '$cli' exists but '--version' failed." -ForegroundColor Red
  exit 1
}
Write-Host "  [ok]   found $cli ($version)" -ForegroundColor Green

$loggedIn = $false
$status = & $cli auth status 2>$null
if ($LASTEXITCODE -eq 0 -and $status) {
  $text = ($status -join "`n")
  if ($text -match '"loggedIn":\s*true|logged in|authenticated') { $loggedIn = $true }
  if ($text -match '"loggedIn":\s*false|not logged in|unauthenticated') { $loggedIn = $false }
}
if (-not $loggedIn) {
  $cfg = Join-Path $env:USERPROFILE '.claude.json'
  if ((Test-Path $cfg) -and ((Get-Content $cfg -Raw) -match '"oauthAccount"|"primaryApiKey"')) { $loggedIn = $true }
  if (Test-Path (Join-Path $env:USERPROFILE '.claude\.credentials.json')) { $loggedIn = $true }
  if ($env:ANTHROPIC_API_KEY) { $loggedIn = $true }
}

if ($loggedIn) {
  Write-Host '  [ok]   login detected' -ForegroundColor Green
  Write-Host 'The CLI is ready. A.I.M. will use this login.'
  exit 0
}

Write-Host '  [fail] no login detected.' -ForegroundColor Red
Write-Host '  Sign in by running `claude` in a terminal and following the prompt (or `claude auth login`'
Write-Host '  on recent versions). A Claude Pro/Max subscription or a Console account is accepted.'
Write-Host '  A.I.M. does not accept API keys directly; it always uses the CLI''s own session.'
exit 2
