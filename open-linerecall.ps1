[CmdletBinding()]
param(
    [switch]$Dev,
    [switch]$Candidate,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'scripts\open-linerecall.ps1'
& $launcher -Dev:$Dev -Candidate:$Candidate -CheckOnly:$CheckOnly
exit $LASTEXITCODE
