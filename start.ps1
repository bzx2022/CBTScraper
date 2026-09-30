# Starts the Milkie Scraper SPA from wherever this script lives.
# Automatically runs npm install first when dependencies are missing or stale.
Set-Location -LiteralPath $PSScriptRoot

if ($null -eq (Get-Command 'node' -ErrorAction SilentlyContinue)) {
    Write-Output 'Node.js not found. Run Install.ps1 first to install prerequisites.'
    exit 1
}

$nodeModules = Join-Path $PSScriptRoot 'node_modules'
$packageJson = Join-Path $PSScriptRoot 'package.json'
$missing = -not (Test-Path -LiteralPath $nodeModules)
$stale = -not $missing -and ((Get-Item -LiteralPath $packageJson).LastWriteTime -gt (Get-Item -LiteralPath $nodeModules).LastWriteTime)
if ($missing -or $stale) {
    Write-Output 'Dependencies missing or out of date. Running npm install first...'
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Output 'npm install failed. Aborting start.'
        exit 1
    }
}

Start-Process 'http://localhost:3000'
npm start
