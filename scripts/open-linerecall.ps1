[CmdletBinding()]
param(
    [switch]$Dev,
    [switch]$Candidate,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot

if ($Dev -and $Candidate) {
    throw 'Choose either -Dev or -Candidate, not both.'
}

if ($Dev) {
    $package = Join-Path $workspace 'package.json'
    if (-not (Test-Path -LiteralPath $package -PathType Leaf)) {
        throw "LineRecall package.json was not found at $package"
    }
    if ($CheckOnly) {
        Write-Host "LineRecall development workspace: $workspace"
        exit 0
    }
    Push-Location $workspace
    try {
        & npm.cmd run dev -- --host 127.0.0.1
        exit $LASTEXITCODE
    } finally {
        Pop-Location
    }
}

$gatePath = Join-Path $workspace 'audit\generated\release-gate.json'
if (-not (Test-Path -LiteralPath $gatePath -PathType Leaf)) {
    throw 'Release-gate evidence is missing. Run npm run release:audit.'
}
$gate = Get-Content -LiteralPath $gatePath -Raw | ConvertFrom-Json

if ($Candidate) {
    $record = $gate.candidate
    if ($null -eq $record) { throw 'The audit record does not identify a review candidate.' }
    $artifact = Join-Path $workspace ([string]$record.path)
    $kind = 'review candidate'
    Write-Warning 'Opening an explicitly requested review candidate. It is not a shippable release.'
} else {
    if ($gate.status -ne 'pass' -or $gate.shippable -ne $true -or $null -eq $gate.artifact) {
        throw 'No shippable LineRecall release exists. External accessibility/legal gates or automated checks are still incomplete. Use -Dev for development or -Candidate to inspect the clearly labeled candidate.'
    }
    $record = $gate.artifact
    $artifact = Join-Path $workspace ([string]$record.path)
    $kind = 'audited release'
}

if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
    throw "The recorded $kind file is missing: $artifact"
}
$actualHash = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedHash = ([string]$record.sha256).ToLowerInvariant()
if ($actualHash -ne $expectedHash) {
    throw "The $kind checksum does not match its audit record. Expected $expectedHash; received $actualHash."
}

$resolvedArtifact = (Resolve-Path -LiteralPath $artifact).Path
Write-Host "LineRecall $kind verified: $resolvedArtifact"
if (-not $CheckOnly) {
    Start-Process -FilePath $resolvedArtifact
}
