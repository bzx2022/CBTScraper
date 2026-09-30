# Builds a GitHub Release asset: dist/CBTScraper-<version>.zip
# Contains code + scripts only — never secrets, state, downloads, or node_modules.
# Run from anywhere; everything resolves from this script's location.
$RootDir = $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $RootDir 'package.json') -Raw | ConvertFrom-Json).version
$DistDir = Join-Path $RootDir 'dist'
$StageDir = Join-Path ([System.IO.Path]::GetTempPath()) ("cbtscraper-stage-" + [System.Guid]::NewGuid().ToString('N'))
$ZipPath = Join-Path $DistDir "CBTScraper-$version.zip"

$files = @(
    'server.js', 'updater.js', 'package.json', 'package-lock.json',
    'start.ps1', 'Install.ps1', 'StartCBTScraper.bat', 'RestartRSSBridge.bat',
    'README.md', 'RSS Service Install instructions.txt'
)
$dirs = @('public', 'rss-bridge')

New-Item -ItemType Directory -Path $DistDir -Force | Out-Null
New-Item -ItemType Directory -Path $StageDir -Force | Out-Null
try {
    foreach ($f in $files) {
        $src = Join-Path $RootDir $f
        if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $StageDir -Force }
        else { Write-Warning "Skipping missing file: $f" }
    }
    foreach ($d in $dirs) {
        $src = Join-Path $RootDir $d
        $dest = Join-Path $StageDir $d
        # Exclude runtime artefacts from the package.
        $exclude = @('node_modules', 'daemon', 'db.json', '*.log')
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
        Get-ChildItem -LiteralPath $src -Force | Where-Object {
            ($exclude -notcontains $_.Name) -and ($_.Extension -ne '.log')
        } | Copy-Item -Destination $dest -Recurse -Force
    }
    if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
    Compress-Archive -Path (Join-Path $StageDir '*') -DestinationPath $ZipPath
    Write-Output "Release asset built: $ZipPath"
} finally {
    Remove-Item -LiteralPath $StageDir -Recurse -Force -ErrorAction SilentlyContinue
}
