param()

$Repo = "ihornone-sandbox/cc-proxy"
$InstallDir = "$env:USERPROFILE\.cc-proxy"

Write-Host "Installing cc-proxy..." -ForegroundColor Green

# Check Node.js
try {
  $nodeVersion = node --version
  Write-Host "Node.js $nodeVersion detected" -ForegroundColor Green
} catch {
  Write-Host "Error: Node.js >= 18 is required. Download from https://nodejs.org" -ForegroundColor Red
  exit 1
}

# Clone or pull
if (Test-Path $InstallDir) {
  Write-Host "Updating existing installation..."
  git -C $InstallDir pull --ff-only
} else {
  git clone "https://github.com/$Repo.git" $InstallDir
}

# Install deps
Set-Location $InstallDir
npm install --production

# Create start script
$BinDir = "$env:USERPROFILE\.local\bin"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$StartScript = @"
@echo off
node "$InstallDir\index.js" %*
"@
Set-Content -Path "$BinDir\cc-proxy.cmd" -Value $StartScript

Write-Host ""
Write-Host "Done!" -ForegroundColor Green
Write-Host "Make sure $BinDir is in your PATH."
Write-Host ""
Write-Host "Run the proxy:"
Write-Host "  cc-proxy"
Write-Host ""
Write-Host "Check that Command Code is authenticated:"
Write-Host "  cmd login"
