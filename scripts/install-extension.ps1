<#
.SYNOPSIS
  Help load the A.I.M. browser extension (unpacked) into Microsoft Edge or Google Chrome.
.DESCRIPTION
  Browsers do not allow a script to install an unpacked extension silently: the
  "Load unpacked" step must be done by hand in the browser's extension page. This
  script does everything around it — it locates the extension folder (the installed
  app's resources\extension, or packages\extension\dist in a checkout), opens the
  browser's extension page and the folder in Explorer, and prints the remaining steps.
.PARAMETER Browser
  edge (default) or chrome.
.PARAMETER Path
  Explicit path to the extension folder (must contain manifest.json).
#>
param(
  [ValidateSet('edge', 'chrome')] [string] $Browser = 'edge',
  [string] $Path
)
$ErrorActionPreference = 'Stop'

function Find-ExtensionFolder {
  if ($Path) { return (Resolve-Path $Path).Path }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\A.I.M.\resources\extension'),
    (Join-Path ${env:ProgramFiles} 'A.I.M.\resources\extension'),
    (Join-Path $PSScriptRoot '..\packages\extension\dist')
  )
  foreach ($c in $candidates) {
    if (Test-Path (Join-Path $c 'manifest.json')) { return (Resolve-Path $c).Path }
  }
  return $null
}

$folder = Find-ExtensionFolder
if (-not $folder) {
  Write-Host 'The extension folder was not found.' -ForegroundColor Yellow
  Write-Host '  Installed app : %LOCALAPPDATA%\Programs\A.I.M.\resources\extension'
  Write-Host '  Source checkout: packages\extension\dist  (run: pnpm build:extension)'
  Write-Host 'Pass the folder explicitly with -Path <folder>.'
  exit 1
}

$exe = if ($Browser -eq 'edge') { 'msedge' } else { 'chrome' }
$page = if ($Browser -eq 'edge') { 'edge://extensions' } else { 'chrome://extensions' }
$name = if ($Browser -eq 'edge') { 'Microsoft Edge' } else { 'Google Chrome' }

Write-Host "Extension folder: $folder"
Write-Host "Opening $name at $page and the folder in Explorer."
try { Start-Process $exe $page } catch { Write-Warning "Could not start $name ($exe). Open $page manually." }
Start-Process explorer.exe $folder

Write-Host ''
Write-Host 'Complete the installation in the browser:' -ForegroundColor Cyan
Write-Host '  1. Turn on "Developer mode" (Edge: toggle in the left pane; Chrome: toggle at the top right).'
Write-Host '  2. Click "Load unpacked" and select the folder shown above.'
Write-Host '  3. Pin the A.I.M. extension to the toolbar (puzzle-piece menu).'
Write-Host '  4. In the A.I.M. desktop app open Settings and copy the pairing token.'
Write-Host '  5. Open the extension (toolbar icon) and paste the token; the port is 47821 unless you changed it.'
Write-Host '     The extension connects to ws://127.0.0.1:<port>/aim/ext and shows "Connected" when paired.'
Write-Host ''
Write-Host 'Notes:'
Write-Host '  - Edge and Chrome will show a "Disable developer mode extensions" prompt on launch; choose Keep or Cancel.'
Write-Host '  - Keep the folder in place: an unpacked extension is loaded from disk every time the browser starts.'
Write-Host '  - After updating A.I.M., click "Reload" on the extension card (or rerun this script).'
