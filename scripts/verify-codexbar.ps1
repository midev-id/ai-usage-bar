$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$distDir = Join-Path $projectRoot "dist"
$exePath = Join-Path $distDir "CodexBar-0.48.0-portable.exe"
$checksumPath = "$exePath.sha256"
$cliPath = Join-Path $distDir "codexbar-cli.exe"
$cliChecksumPath = "$cliPath.sha256"

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
$cliStatus = "NotFound"
$cliVersion = $null
$cliHash = $null
$cliExe = $null

if (Test-Path -LiteralPath $cliPath) {
    if (-not (Test-Path -LiteralPath $cliChecksumPath)) {
        throw "CLI checksum file not found: $cliChecksumPath"
    }

    $cliHash = (Get-FileHash -LiteralPath $cliPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $expectedCliLine = (Get-Content -LiteralPath $cliChecksumPath -Raw).Trim()
    $expectedCliHash = ($expectedCliLine -split "\s+")[0].ToLowerInvariant()

    if ($cliHash -ne $expectedCliHash) {
        throw "CLI checksum mismatch. Expected $expectedCliHash, got $cliHash"
    }

    $cliVersion = (& $cliPath --version)
    $cliStatus = "OK"
    $cliExe = $cliPath
}

[PSCustomObject]@{
    Status = "OK"
    Version = $versionInfo.ProductVersion
    FileVersion = $versionInfo.FileVersion
    Sha256 = $actualHash
    Exe = $exePath
    CliStatus = $cliStatus
    CliVersion = $cliVersion
    CliSha256 = $cliHash
    CliExe = $cliExe
}
