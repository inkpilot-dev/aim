<#
.SYNOPSIS
  Cut a release: bump packages/desktop version, commit, tag vX.Y.Z and push.
  The Release workflow then publishes installers and auto-update metadata to GitHub Releases.
.EXAMPLE
  .\scripts\release.ps1 0.2.0
#>
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [switch]$NoPush
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$') { throw "Version must be semver, e.g. 0.2.0" }
Set-Location (Join-Path $PSScriptRoot '..')
if (git status --porcelain) { throw 'Working tree is not clean. Commit or stash first.' }
git remote get-url origin | Out-Null
$pkgPath = 'packages/desktop/package.json'
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$pkg.version = $Version
($pkg | ConvertTo-Json -Depth 20) + "`n" | Set-Content $pkgPath -NoNewline
git add $pkgPath
git commit -m "release: v$Version"
git tag -a "v$Version" -m "A.I.M. v$Version"
if (-not $NoPush) {
  git push origin HEAD
  git push origin "v$Version"
  Write-Host "Pushed v$Version. Watch the Release workflow on GitHub."
} else {
  Write-Host "Created commit and tag v$Version (not pushed)."
}
