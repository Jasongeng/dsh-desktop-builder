#requires -Version 5.1
<#
.SYNOPSIS
    Build a Windows x64 installer from one pinned upstream DSH revision.
.DESCRIPTION
    Prepares file-owned release settings, applies the overlay, and runs official packaging.
    Local unsigned builds can explicitly omit mandatory updates with -DisableMandatoryUpdate.
.PARAMETER Ref
    Upstream tag, branch or commit. Overrides Channel.
.PARAMETER ReleaseConfig
    Optional dotenv input. Defaults to .env.windows in the builder directory.
.PARAMETER CheckOnly
    Prepare the checkout and dependencies, then validate configuration and build tools.
#>
[CmdletBinding()]
param(
    [string]$Ref,
    [ValidateSet('master', 'stable', 'prerelease')][string]$Channel = 'master',
    [ValidateSet('auto', 'signed', 'unsigned')][string]$Mode = 'auto',
    [string]$ReleaseConfig,
    [string]$BuildVersion,
    [switch]$DisableMandatoryUpdate,
    [switch]$Dir,
    [switch]$Force,
    [switch]$NoInstall,
    [switch]$NoFetch,
    [switch]$CheckOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$BuilderRoot = $PSScriptRoot
$HarnessRoot = Join-Path $BuilderRoot 'harness'
$DistRoot = Join-Path $BuilderRoot 'dist'
$TargetName = 'win-x64'
$HarnessUrl = 'https://github.com/deepseek-ai/deepseek-harness.git'

function Invoke-Native {
    param([string]$File, [string[]]$Arguments, [string]$WorkingDirectory = $BuilderRoot)
    Push-Location $WorkingDirectory
    try {
        & $File @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE" }
    }
    finally { Pop-Location }
}
function Get-GitOutput {
    param([string[]]$Arguments)
    $value = & git -C $HarnessRoot @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the upstream checkout' }
    return @($value)
}
function Write-JsonFile {
    param($Value, [string]$Path)
    [System.IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 10) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
}

Write-Host '== [1/6] upstream checkout ==' -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath (Join-Path $HarnessRoot '.git'))) {
    if ($NoFetch) { throw '-NoFetch requires an existing upstream checkout' }
    Invoke-Native 'git' @('clone', '--filter=blob:none', $HarnessUrl, $HarnessRoot)
}
if (-not $NoFetch) { Invoke-Native 'git' @('-C', $HarnessRoot, 'fetch', 'origin', '--tags', '--prune') }
if (-not $Ref) {
    if ($Channel -eq 'master') { $Ref = 'origin/master' }
    else {
        $tags = @(Get-GitOutput @('tag', '--list', 'dsh-v*', '--sort=-v:refname'))
        if ($Channel -eq 'stable') { $tags = @($tags | Where-Object { $_ -match '^dsh-v\d+\.\d+\.\d+$' }) }
        if ($tags.Count -eq 0) { throw "No upstream release tag matches channel $Channel" }
        $Ref = $tags[0]
    }
}
$commit = (Get-GitOutput @('rev-parse', '--verify', ($Ref + '^{commit}'))) -join ''
$shortCommit = $commit.Substring(0, 10)
$previousCommit = (Get-GitOutput @('rev-parse', 'HEAD')) -join ''
$refreshBuildState = $previousCommit -ne $commit
# Save known overlay edits before refreshing the build checkout; never clean untracked files.
$overlayPaths = @(
    'apps/desktop/electron-builder.config.mjs',
    'apps/desktop/tests/fixtures/runtime-payload-smoke.mjs',
    'apps/desktop/scripts/electron-builder-config.mjs',
    'apps/desktop/scripts/desktop-package-environment.mjs'
)
$changed = @(Get-GitOutput @('diff', 'HEAD', '--name-only'))
if (@($changed | Where-Object { $_ -notin $overlayPaths }).Count -gt 0) {
    throw 'The build checkout has tracked edits outside the overlay. Preserve them before rebuilding.'
}
if ($changed.Count -gt 0) {
    $backupRoot = Join-Path $DistRoot 'source-backups'
    New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
    $backup = Join-Path $backupRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '.patch')
    Invoke-Native 'git' @('-C', $HarnessRoot, 'diff', 'HEAD', '--binary', ('--output=' + $backup))
    foreach ($relative in $changed) {
        Invoke-Native 'git' @('-C', $HarnessRoot, 'restore', '--source=HEAD', '--staged', '--worktree', '--', $relative)
    }
}
Invoke-Native 'git' @('-C', $HarnessRoot, 'checkout', '--quiet', '--detach', $commit)
$manifest = Get-Content -LiteralPath (Join-Path $HarnessRoot 'package.json') -Raw | ConvertFrom-Json
$upstreamVersion = $manifest.version
if (-not $manifest.scripts.'package:desktop:win:x64:unsigned') { throw 'This upstream revision lacks unsigned desktop packaging' }
Write-Host "DSH $upstreamVersion ($shortCommit)"

Write-Host '== [2/6] source overlay ==' -ForegroundColor Cyan
Invoke-Native 'node' @((Join-Path $BuilderRoot 'overlay\apply-overlay.mjs'), $HarnessRoot)
Write-Host '== [3/6] release configuration ==' -ForegroundColor Cyan
if (-not $env:DSH_DESKTOP_PRODUCT_NAME) { $env:DSH_DESKTOP_PRODUCT_NAME = 'DSH Desktop' }
$icon = Join-Path $BuilderRoot 'branding\icon.ico'
if (Test-Path -LiteralPath $icon) { $env:DSH_DESKTOP_ICON = $icon }
else { Remove-Item Env:\DSH_DESKTOP_ICON -ErrorAction SilentlyContinue }
$policyMode = if ($DisableMandatoryUpdate) { 'disabled' } else { 'configured' }
$configArguments = @((Join-Path $BuilderRoot 'scripts\prepare-config.mjs'), $HarnessRoot, '--mode', $Mode, '--policy', $policyMode)
if ($ReleaseConfig) { $configArguments += @('--source', (Resolve-Path -LiteralPath $ReleaseConfig).Path) }
$configJson = & node @configArguments
if ($LASTEXITCODE -ne 0) { throw 'Release configuration could not be prepared' }
$config = $configJson | ConvertFrom-Json
$releaseMode = $config.mode
Write-Host "Product: $($env:DSH_DESKTOP_PRODUCT_NAME); app id: $($config.appId); mode: $releaseMode; policy: $policyMode"
$publishedVersion = if ($BuildVersion) { $BuildVersion } else { $upstreamVersion }
if ($publishedVersion -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') { throw '-BuildVersion must be an explicit semantic version without build metadata' }
$suffix = if ($Dir) { '-dir' } else { '' }
$outputRoot = Join-Path $DistRoot "$publishedVersion-$shortCommit-$releaseMode$suffix"
if ((Test-Path -LiteralPath (Join-Path $outputRoot 'build-info.json')) -and -not $Force -and -not $CheckOnly) {
    Write-Host "Completed output exists: $outputRoot. Use -Force to rebuild."
    return
}

Write-Host '== [4/6] dependencies and preflight ==' -ForegroundColor Cyan
if (-not $env:PYTHON -and (Get-Command 'py' -ErrorAction SilentlyContinue)) {
    $pythonPath = & py -3 -c 'import sys; print(sys.executable)' 2>$null
    if ($LASTEXITCODE -eq 0 -and $pythonPath -and (Test-Path -LiteralPath $pythonPath)) { $env:PYTHON = $pythonPath }
}
if (-not $NoInstall) { Invoke-Native 'pnpm' @('install', '--frozen-lockfile') $HarnessRoot }
$pnpmEntry = Join-Path $HarnessRoot 'apps\desktop\node_modules\pnpm\bin\pnpm.mjs'
if (-not (Test-Path -LiteralPath $pnpmEntry)) { throw 'Missing pnpm JavaScript entry; install upstream dependencies first' }
$env:npm_execpath = $pnpmEntry
foreach ($group in @(Get-ChildItem -LiteralPath (Join-Path $HarnessRoot 'packages') -Directory)) {
    foreach ($package in @(Get-ChildItem -LiteralPath $group.FullName -Directory)) {
        if (-not (Test-Path -LiteralPath (Join-Path $package.FullName 'package.json'))) { $refreshBuildState = $true }
    }
}
$packageArguments = @('--import', 'tsx/esm', 'apps/desktop/scripts/package-target.ts', $TargetName)
if ($releaseMode -eq 'unsigned') { $packageArguments += '--unsigned' }
if ($Dir) { $packageArguments += '--dir' }
if ($BuildVersion) { $packageArguments += @('--build-version', $BuildVersion) }
Invoke-Native 'node' ($packageArguments + '--check') $HarnessRoot
if ($CheckOnly) { return }

Write-Host '== [5/6] official packaging ==' -ForegroundColor Cyan
if ($refreshBuildState) {
    $records = Join-Path $HarnessRoot 'apps\desktop\.desktop-build\packaging-runs'
    if (Test-Path -LiteralPath $records) {
        $evidence = Join-Path $DistRoot ('build-evidence\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        New-Item -ItemType Directory -Path $evidence -Force | Out-Null
        Copy-Item -LiteralPath $records -Destination $evidence -Recurse
    }
    Write-Host 'Refreshing generated build state after an upstream change or deleted package'
    Invoke-Native 'node' @($pnpmEntry, 'run', 'clean') $HarnessRoot
}
$targetRoot = [System.IO.Path]::GetFullPath((Join-Path $HarnessRoot 'apps\desktop\.desktop-build\targets\win-x64'))
$artifactName = if ($releaseMode -eq 'unsigned') { 'unsigned-artifacts' } else { 'artifacts' }
$previousArtifacts = [System.IO.Path]::GetFullPath((Join-Path $targetRoot $artifactName))
if (Test-Path -LiteralPath $previousArtifacts) {
    $artifactBackup = $previousArtifacts + '-previous-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    $targetPrefix = $targetRoot.TrimEnd('\') + '\'
    if (-not $previousArtifacts.StartsWith($targetPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $artifactBackup.StartsWith($targetPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Artifact paths are outside the selected build target' }
    Move-Item -LiteralPath $previousArtifacts -Destination $artifactBackup
}
$packageLog = Join-Path $BuilderRoot 'package.log'
Push-Location $HarnessRoot
try {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & node @packageArguments *>&1 | Tee-Object -FilePath $packageLog
    $packageExit = $LASTEXITCODE
}
finally { $ErrorActionPreference = $previousPreference; Pop-Location }
if ($packageExit -ne 0) { throw "Packaging failed with exit code $packageExit. See $packageLog" }

Write-Host '== [6/6] verified artifacts ==' -ForegroundColor Cyan
if (Test-Path -LiteralPath $outputRoot) {
    $resolvedOutput = [System.IO.Path]::GetFullPath($outputRoot)
    $resolvedDist = [System.IO.Path]::GetFullPath($DistRoot).TrimEnd('\') + '\'
    if (-not $resolvedOutput.StartsWith($resolvedDist, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Output directory is outside dist' }
    Move-Item -LiteralPath $outputRoot -Destination ($outputRoot + '-previous-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$collectArguments = @((Join-Path $BuilderRoot 'scripts\collect-artifacts.mjs'), $HarnessRoot, $outputRoot, $releaseMode)
if ($Dir) { $collectArguments += '--dir' }
$artifactsJson = & node @collectArguments
if ($LASTEXITCODE -ne 0) { throw 'Artifact verification or collection failed' }
$artifacts = $artifactsJson | ConvertFrom-Json
$info = [ordered]@{
    upstreamRef = $Ref
    upstreamCommit = $commit
    upstreamVersion = $upstreamVersion
    buildVersion = $publishedVersion
    releaseMode = $releaseMode
    mandatoryUpdate = $policyMode
    appId = $config.appId
    productName = $env:DSH_DESKTOP_PRODUCT_NAME
    target = $TargetName
    directory = [bool]$Dir
    outputRoot = $outputRoot
    artifacts = $artifacts
    builtAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
}
Write-JsonFile $info (Join-Path $outputRoot 'build-info.json')
Write-JsonFile $info (Join-Path $DistRoot 'last-build.json')
Write-Host "Build complete: $outputRoot" -ForegroundColor Green
Get-ChildItem -LiteralPath $outputRoot -File | Select-Object Name, Length
