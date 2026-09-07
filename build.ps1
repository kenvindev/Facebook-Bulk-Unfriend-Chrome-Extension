# Build + zip Chrome extension package
# Usage: .\build.ps1

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

$manifestPath = Join-Path $root "manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath)) {
  Write-Error "manifest.json not found"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$manifest.version
if (-not $version) { $version = "0.0.0" }

$stage = Join-Path $root "dist\package"
$dist = Join-Path $root "dist"
$zipName = "facebook-bulk-unfriend-v$version.zip"
$zipPath = Join-Path $dist $zipName
$zipLatest = Join-Path $dist "facebook-bulk-unfriend.zip"

Write-Host "Building Facebook Bulk Unfriend v$version"

if (Test-Path -LiteralPath $stage) {
  Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage "icons") -Force | Out-Null
if (-not (Test-Path -LiteralPath $dist)) {
  New-Item -ItemType Directory -Path $dist -Force | Out-Null
}

$files = @(
  "manifest.json",
  "background.js",
  "content.js",
  "content.css",
  "sidepanel.html",
  "sidepanel.js",
  "sidepanel.css",
  "README.md"
)

foreach ($f in $files) {
  $src = Join-Path $root $f
  if (-not (Test-Path -LiteralPath $src)) {
    Write-Error "Missing required file: $f"
  }
  Copy-Item -LiteralPath $src -Destination (Join-Path $stage $f) -Force
}

$iconNames = @("icon16.png", "icon48.png", "icon128.png")
foreach ($icon in $iconNames) {
  $fromIcons = Join-Path $root "icons\$icon"
  $fromRoot = Join-Path $root $icon
  $dest = Join-Path $stage "icons\$icon"
  if (Test-Path -LiteralPath $fromIcons) {
    Copy-Item -LiteralPath $fromIcons -Destination $dest -Force
  } elseif (Test-Path -LiteralPath $fromRoot) {
    Copy-Item -LiteralPath $fromRoot -Destination $dest -Force
  } else {
    Write-Error "Missing icon: $icon"
  }
}

# Optional gitignore inside package (keeps Load unpacked folder clean if copied elsewhere)
$pkgIgnore = @"
*.zip
*.crx
*.pem
.DS_Store
Thumbs.db
"@
Set-Content -LiteralPath (Join-Path $stage ".gitignore") -Value $pkgIgnore -Encoding UTF8

foreach ($z in @($zipPath, $zipLatest)) {
  if (Test-Path -LiteralPath $z) {
    Remove-Item -LiteralPath $z -Force
  }
}

Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipPath -Force
Copy-Item -LiteralPath $zipPath -Destination $zipLatest -Force

$zipInfo = Get-Item -LiteralPath $zipPath
Write-Host "OK package: $stage"
Write-Host "OK zip:     $zipPath ($([math]::Round($zipInfo.Length / 1KB, 1)) KB)"
Write-Host "OK latest:  $zipLatest"
Write-Host "Load unpacked: dist\package"
