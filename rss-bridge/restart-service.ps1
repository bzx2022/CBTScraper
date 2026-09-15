# Restarts the MilkieRSSBridge Windows Service (rss-bridge/server.js).
# Double-click RestartRSSBridge.bat, or run this script directly.
# Service control requires elevation — the script re-launches itself as admin.

$ServiceName = 'MilkieRSSBridge'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
    Write-Output 'Restart requires elevation. Re-launching as administrator...'
    Start-Process powershell.exe -Verb RunAs -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', "`"$PSCommandPath`""
    )
    exit
}

# NOTE: the winsw wrapper registers the service Name as "milkierssbridge.exe"
# with DisplayName "MilkieRSSBridge", so resolve by either property.
$svc = Get-Service | Where-Object {
    $_.Name -eq $ServiceName -or $_.DisplayName -eq $ServiceName -or
    $_.Name -eq 'milkierssbridge.exe'
} | Select-Object -First 1
if (-not $svc) {
    Write-Output "Service '$ServiceName' is not installed."
    Write-Output 'Install it first from an elevated prompt:'
    Write-Output '  cd "E:\My Documents\Default Project\rss-bridge"; node install-service.js'
    exit 1
}

Write-Output "Restarting service '$($svc.Name)'..."
Restart-Service -InputObject $svc -Force -ErrorAction Stop

# Wait up to 30s for the service to report Running.
$deadline = (Get-Date).AddSeconds(30)
do {
    Start-Sleep -Seconds 2
    $svc = Get-Service -Name $svc.Name
} while ($svc.Status -ne 'Running' -and (Get-Date) -lt $deadline)

if ($svc.Status -eq 'Running') {
    Write-Output "Service '$ServiceName' is Running. Feed: http://127.0.0.1:8080/feed.xml"
} else {
    Write-Output "WARNING: service status is '$($svc.Status)' after 30s. Check rss-bridge logs."
    exit 1
}
