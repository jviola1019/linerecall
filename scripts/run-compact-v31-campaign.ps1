[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PlansDirectory,

    [Parameter(Mandatory = $true)]
    [string]$ArchivesDirectory,

    [Parameter(Mandatory = $true)]
    [string]$CampaignRoot,

    [string]$FirstRunId = 'broadcast-benchmark-run-one',
    [string]$SecondRunId = 'broadcast-benchmark-run-two',
    [switch]$Execute
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$plans = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $PlansDirectory))
$archives = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $ArchivesDirectory))
$campaign = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $CampaignRoot))
$proposal = Join-Path $repositoryRoot 'data/manifests/compact-v31/bootstrap/broadcast-proposal-c598a637c729be22a61583345b33589f462f1fb07294ef53678f0ecc85e857d5.json'
$observation = Join-Path $repositoryRoot 'data/manifests/compact-v31/bootstrap/broadcast-observation-043b06dfd1fdf6adee65b1e1d29e18a561c0a046c4d6a5dd124aeb138465d56c.json'

function Assert-ExactHash([string]$Path, [string]$Expected) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required file is missing: $Path"
    }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Expected) {
        throw "SHA-256 mismatch for $Path"
    }
}

Assert-ExactHash $proposal 'c598a637c729be22a61583345b33589f462f1fb07294ef53678f0ecc85e857d5'
Assert-ExactHash $observation '043b06dfd1fdf6adee65b1e1d29e18a561c0a046c4d6a5dd124aeb138465d56c'

if (-not (Test-Path -LiteralPath $plans -PathType Container)) {
    throw "Plan directory does not exist: $plans"
}
if (-not (Test-Path -LiteralPath $archives -PathType Container)) {
    throw "Archive directory does not exist: $archives"
}
$planFiles = @(Get-ChildItem -LiteralPath $plans -File)
if ($planFiles.Count -ne 79 -or -not (Test-Path -LiteralPath (Join-Path $plans 'plan-review.json') -PathType Leaf)) {
    throw 'Plan directory must contain exactly 78 archive plans and plan-review.json.'
}
$archiveFiles = @(Get-ChildItem -LiteralPath $archives -File -Filter 'lichess_db_broadcast_*.pgn.zst')
if ($archiveFiles.Count -ne 78) {
    throw "Archive directory must contain exactly 78 broadcast archives; found $($archiveFiles.Count)."
}

if (-not (Test-Path -LiteralPath $campaign)) {
    New-Item -ItemType Directory -Path $campaign | Out-Null
}
$firstWork = Join-Path $campaign 'run-one'
$secondWork = Join-Path $campaign 'run-two'
foreach ($work in @($firstWork, $secondWork)) {
    if (-not (Test-Path -LiteralPath $work)) {
        New-Item -ItemType Directory -Path $work | Out-Null
    }
}

$firstPlan = Join-Path $plans 'broadcast-2020-01.json'
Push-Location $repositoryRoot
try {
    & npm run data:evidence-v31-preflight -- --plan $firstPlan --work-dir $firstWork
    if ($LASTEXITCODE -ne 0) { throw 'First clean-run preflight failed. Free memory or storage and retry; no source was opened.' }
    & npm run data:evidence-v31-preflight -- --plan $firstPlan --work-dir $secondWork
    if ($LASTEXITCODE -ne 0) { throw 'Second clean-run preflight failed. Free memory or storage and retry; no source was opened.' }

    if (-not $Execute) {
        Write-Host 'Preflight passed. Re-run with -Execute to start the two sequential, resumable broadcast benchmarks.'
        exit 0
    }

    # The executor rechecks the current source snapshot, every archive digest,
    # resource limits before each archive, and same-run checkpoint identity.
    & npm run data:evidence-v31-benchmark -- --plans-dir $plans --archives-dir $archives --work-dir $firstWork --run-id $FirstRunId
    if ($LASTEXITCODE -ne 0) { throw 'First benchmark did not complete. Re-run the same command to resume its authenticated checkpoints.' }
    & npm run data:evidence-v31-benchmark -- --plans-dir $plans --archives-dir $archives --work-dir $secondWork --run-id $SecondRunId
    if ($LASTEXITCODE -ne 0) { throw 'Second benchmark did not complete. Re-run the same command to resume its authenticated checkpoints.' }

    $comparison = Join-Path $campaign 'benchmark-repeatability.json'
    & npm run data:evidence-v31-compare -- `
        --first-run (Join-Path $firstWork "v31/runs/$FirstRunId/receipt.json") `
        --first-candidate-merge (Join-Path $firstWork "v31/merged/$FirstRunId/candidate/receipt.json") `
        --first-exact-merge (Join-Path $firstWork "v31/merged/$FirstRunId/exact/receipt.json") `
        --second-run (Join-Path $secondWork "v31/runs/$SecondRunId/receipt.json") `
        --second-candidate-merge (Join-Path $secondWork "v31/merged/$SecondRunId/candidate/receipt.json") `
        --second-exact-merge (Join-Path $secondWork "v31/merged/$SecondRunId/exact/receipt.json") `
        --output $comparison `
        --compared-at ([DateTimeOffset]::UtcNow.ToString('o'))
    if ($LASTEXITCODE -ne 0) { throw 'The two benchmark runs are not proven byte-identical.' }

    Write-Host "Benchmark comparison written to $comparison"
    Write-Host 'Q2 has not started. A named reviewer must approve the exact repeatability receipt and production authorization first.'
} finally {
    Pop-Location
}
