$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$distDir = Join-Path $projectRoot "dist"
$exePath = Join-Path $distDir "CodexBar-0.48.0-portable.exe"
$checksumPath = "$exePath.sha256"

if (-not (Test-Path -LiteralPath $exePath)) {
    throw "Executable not found: $exePath"
}

if (-not (Test-Path -LiteralPath $checksumPath)) {
    throw "Checksum file not found: $checksumPath"
}

$actualHash = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedLine = (Get-Content -LiteralPath $checksumPath -Raw).Trim()
$expectedHash = ($expectedLine -split "\s+")[0].ToLowerInvariant()

if ($actualHash -ne $expectedHash) {
    throw "Checksum mismatch. Expected $expectedHash, got $actualHash"
}

$versionInfo = (Get-Item -LiteralPath $exePath).VersionInfo

[PSCustomObject]@{
    Status = "OK"
    Version = $versionInfo.ProductVersion
    FileVersion = $versionInfo.FileVersion
    Sha256 = $actualHash
    Exe = $exePath
}
