# Milkie suite one-shot installer / uninstaller.
# Run from anywhere: all paths resolve from this script's own location, as long
# as rss-bridge/ sits beside it with server.js + install-service.js inside.
#
#   powershell -ExecutionPolicy Bypass -File Install.ps1                 # install (prompts at each step)
#   powershell -ExecutionPolicy Bypass -File Install.ps1 -Yes           # install (accept every prompt)
#   powershell -ExecutionPolicy Bypass -File Install.ps1 -Mode Uninstall # remove the Windows Service
param(
    [ValidateSet('Install', 'Uninstall')]
    [string]$Mode = 'Install',
    [switch]$Yes
)

$RootDir = $PSScriptRoot
$BridgeDir = Join-Path $RootDir 'rss-bridge'

function Test-CommandPresent($name) {
    return $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Confirm-Step($message) {
    if ($Yes) { return $true }
    $answer = Read-Host "$message [Y/n]"
    return ($answer -eq '' -or $answer -match '^(?i:y|yes)$')
}

function Invoke-Elevated($commandLine) {
    # Re-launches a command in an elevated shell and waits for it.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command $commandLine"
    $psi.Verb = 'runas'
    $psi.UseShellExecute = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    $proc.WaitForExit()
    return $proc.ExitCode
}

function Ensure-Node {
    if (Test-CommandPresent 'node') {
        Write-Output "Node.js found: $(node --version) (npm $(npm --version))"
        return
    }
    Write-Warning 'Node.js is not installed or not on PATH.'
    if (-not (Confirm-Step 'Download and install Node.js LTS now?')) {
        throw 'Node.js is required. Re-run after installing it.'
    }
    if (Test-CommandPresent 'winget') {
        Write-Output 'Installing Node.js LTS via winget...'
        winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        # Pick up the new PATH entries without a reboot/logoff.
        $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                    [System.Environment]::GetEnvironmentVariable('Path', 'User')
    } else {
        Write-Output 'winget not available — opening the Node.js download page instead.'
        Start-Process 'https://nodejs.org/en/download'
        throw 'Install Node.js LTS, restart the shell, then re-run Install.ps1.'
    }
    if (-not (Test-CommandPresent 'node')) {
        throw 'Node.js install did not complete. Restart the shell and re-run Install.ps1.'
    }
    Write-Output "Node.js installed: $(node --version)"
}

function Ensure-Dependencies($dir, $label) {
    $nodeModules = Join-Path $dir 'node_modules'
    $packageJson = Join-Path $dir 'package.json'
    if (-not (Test-Path -LiteralPath $packageJson)) {
        Write-Warning "No package.json in $dir — skipping $label."
        return
    }
    $missing = -not (Test-Path -LiteralPath $nodeModules)
    $stale = -not $missing -and ((Get-Item -LiteralPath $packageJson).LastWriteTime -gt (Get-Item -LiteralPath $nodeModules).LastWriteTime)
    if (-not ($missing -or $stale)) {
        Write-Output "$label dependencies are up to date."
        return
    }
    $reason = if ($missing) { 'missing' } else { 'out of date (package.json is newer)' }
    if (-not (Confirm-Step "$label dependencies are $reason. Run npm install?")) {
        Write-Warning "Skipping dependency install for $label — the app may fail to start."
        return
    }
    Push-Location -LiteralPath $dir
    try {
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed for $label." }
        Write-Output "$label dependencies installed."
    } finally {
        Pop-Location
    }
}

function Get-BridgeService {
    return Get-Service | Where-Object {
        $_.Name -eq 'MilkieRSSBridge' -or $_.DisplayName -eq 'MilkieRSSBridge' -or
        $_.Name -eq 'milkierssbridge.exe'
    } | Select-Object -First 1
}

if ($Mode -eq 'Uninstall') {
    Write-Output 'Milkie suite uninstall: removing the RSS bridge Windows Service...'
    $code = Invoke-Elevated "& { Set-Location -LiteralPath '$BridgeDir'; node uninstall-service.js }"
    if ($code -ne 0) { throw "Service removal failed (exit $code)." }
    Write-Output 'Uninstall complete.'
    exit 0
}

# --- Install flow ---
Write-Output '=== Milkie suite installer ==='
Write-Output "App folder: $RootDir"
Write-Output ''

# Step 1: runtime.
Ensure-Node
Write-Output ''

# Step 2: dependencies for both projects.
Ensure-Dependencies $RootDir 'SPA'
Ensure-Dependencies $BridgeDir 'RSS bridge'
Write-Output ''

# Step 3: Windows Service (requires elevation).
$svc = Get-BridgeService
if ($svc) {
    Write-Output "RSS bridge service already installed (status: $($svc.Status))."
    if ($svc.Status -ne 'Running' -and (Confirm-Step 'Start it now?')) {
        $code = Invoke-Elevated "Restart-Service -Name '$($svc.Name)' -Force"
        if ($code -ne 0) { Write-Warning 'Could not start the service — start it manually from services.msc.' }
    }
} elseif (Confirm-Step 'Install and start the RSS bridge Windows Service? (requires admin)') {
    if (-not (Test-Admin)) { Write-Output 'Elevation required — continuing in an admin window...' }
    $code = Invoke-Elevated "& { Set-Location -LiteralPath '$BridgeDir'; node install-service.js }"
    if ($code -ne 0) { throw "Service install failed (exit $code)." }
    Write-Output 'Service installed and started. Feed: http://127.0.0.1:8080/feed.xml'
}

Write-Output ''
Write-Output 'Install complete. Start the SPA with StartCBTScraper.bat (or: npm start).'
