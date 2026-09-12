#requires -Version 5.1
<#
.SYNOPSIS
    Build a Windows x64 DeepSeek Harness desktop installer from a tracked upstream revision.

.DESCRIPTION
    Checks out one upstream deepseek-harness revision into ./harness, applies the branding overlay,
    and produces an installer through the official apps/desktop packaging path.

    Signing mode is detected rather than configured. When all four DSH_DESKTOP_WINDOWS_* inputs are
    present and valid the release is EV-signed and carries electron-updater channel metadata;
    otherwise an unsigned installer is produced with no update feed.

    Every message is ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less file with the
    ANSI code page, which corrupts non-ASCII string literals and can even change how quotes pair up.

.PARAMETER Ref
    Upstream git revision (tag, branch, or commit). Overrides -Channel.

.PARAMETER Channel
    master (default) tracks origin/master. stable picks the newest dsh-v<major>.<minor>.<patch> tag.
    prerelease picks the newest dsh-v* tag including -rc and -alpha.

    The default is master, not the newest tag, because unsigned Windows packaging needs the
    DSH_DESKTOP_UNSIGNED support that only landed after the dsh-v0.1.5-rc.2 tag.

.PARAMETER Dir
    Produce an unpacked application directory instead of an installer.

.PARAMETER Force
    Rebuild even when the output directory already exists.

.PARAMETER NoInstall
    Skip pnpm install in the harness checkout.
#>
[CmdletBinding()]
param(
    [string]$Ref,
    [ValidateSet('master', 'stable', 'prerelease')][string]$Channel = 'master',
    [switch]$Dir,
    [switch]$Force,
    [switch]$NoInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$BuilderRoot = $PSScriptRoot
$HarnessRoot = Join-Path $BuilderRoot 'harness'
$OverlayRoot = Join-Path $BuilderRoot 'overlay'
$DistRoot = Join-Path $BuilderRoot 'dist'
$IconSource = Join-Path $BuilderRoot 'branding\icon.ico'
$HarnessUrl = 'https://github.com/deepseek-ai/deepseek-harness.git'
$TargetName = 'win-x64'
$UnsignedScriptName = 'package:desktop:win:x64:unsigned'

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$File,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$WorkingDirectory = $BuilderRoot
    )
    Push-Location $WorkingDirectory
    try {
        & $File @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$File $($Arguments -join ' ') exited with $LASTEXITCODE" }
    }
    finally { Pop-Location }
}

function Get-GitOutput {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $output = & git -C $HarnessRoot @Arguments
    if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') exited with $LASTEXITCODE" }
    return @($output)
}

function Get-EnvironmentValue {
    param([Parameter(Mandatory = $true)][string]$Name)
    return Get-Item -Path "Env:$Name" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Value
}

function Test-ScriptExists {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$Name
    )
    return @($Manifest.scripts.PSObject.Properties | Where-Object { $_.Name -eq $Name }).Count -gt 0
}

# JSON must be written as UTF-8 without a BOM; a BOM makes strict JSON readers fail.
function Write-JsonFile {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $json = $Value | ConvertTo-Json
    [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# ---------------------------------------------------------------------------
Write-Host '== [1/6] upstream checkout ==' -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath (Join-Path $HarnessRoot '.git'))) {
    Write-Host "cloning $HarnessUrl"
    Invoke-Native -File 'git' -Arguments @('clone', '--filter=blob:none', $HarnessUrl, $HarnessRoot)
}
Invoke-Native -File 'git' -Arguments @('-C', $HarnessRoot, 'fetch', 'origin', '--tags', '--prune', '--force')

if (-not $Ref) {
    if ($Channel -eq 'master') {
        $Ref = 'origin/master'
    }
    else {
        $tags = Get-GitOutput -Arguments @('tag', '--list', 'dsh-v*', '--sort=-v:refname')
        if ($Channel -eq 'stable') { $tags = @($tags | Where-Object { $_ -match '^dsh-v\d+\.\d+\.\d+$' }) }
        if ($tags.Count -eq 0) { throw "no dsh-v* tag matched channel '$Channel'" }
        $Ref = $tags[0]
    }
}
Write-Host "revision: $Ref"

# The overlay dirties the work tree; every build restarts from the pinned commit. Only tracked
# files are reset -- git clean is deliberately avoided so untracked content is never deleted.
Invoke-Native -File 'git' -Arguments @('-C', $HarnessRoot, 'reset', '--hard', '--quiet')
Invoke-Native -File 'git' -Arguments @('-C', $HarnessRoot, 'checkout', '--quiet', '--detach', $Ref)

$manifest = Get-Content -LiteralPath (Join-Path $HarnessRoot 'package.json') -Raw | ConvertFrom-Json
$upstreamVersion = $manifest.version
$supportsUnsigned = Test-ScriptExists -Manifest $manifest -Name $UnsignedScriptName
$commit = (Get-GitOutput -Arguments @('rev-parse', '--short', 'HEAD')) -join ''
Write-Host "upstream dsh version: $upstreamVersion ($commit)"

# The upstream version does not change between master commits, so the commit identifies the build.
$outputRoot = Join-Path $DistRoot "$upstreamVersion-$commit"
if ((Test-Path -LiteralPath $outputRoot) -and -not $Force) {
    Write-Host "dist/$upstreamVersion-$commit already exists; pass -Force to rebuild" -ForegroundColor Yellow
    return
}

# ---------------------------------------------------------------------------
Write-Host '== [2/6] branding overlay ==' -ForegroundColor Cyan
$overlayScript = Join-Path $OverlayRoot 'apply-branding.mjs'
if (-not (Test-Path -LiteralPath $overlayScript)) { throw "missing branding overlay script: $overlayScript" }
Invoke-Native -File 'node' -Arguments @(
    $overlayScript,
    (Join-Path $HarnessRoot 'apps\desktop\electron-builder.config.mjs')
) -WorkingDirectory $HarnessRoot

# ---------------------------------------------------------------------------
Write-Host '== [3/6] release environment ==' -ForegroundColor Cyan
if (-not (Get-EnvironmentValue -Name 'DSH_DESKTOP_APP_ID')) {
    $env:DSH_DESKTOP_APP_ID = 'com.example.dsh-desktop'
    Write-Warning "DSH_DESKTOP_APP_ID was not set; using $($env:DSH_DESKTOP_APP_ID). Set your own reverse-DNS identifier."
}
if ($env:DSH_DESKTOP_APP_ID -notmatch '^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$') {
    throw 'DSH_DESKTOP_APP_ID must be a reverse-DNS identifier such as com.yourorg.dsh'
}
if (-not (Get-EnvironmentValue -Name 'DSH_DESKTOP_PRODUCT_NAME')) {
    $env:DSH_DESKTOP_PRODUCT_NAME = 'DeepSeek Harness'
}
Write-Host "app id:       $($env:DSH_DESKTOP_APP_ID)"
Write-Host "product name: $($env:DSH_DESKTOP_PRODUCT_NAME)"

# The icon copied by a previous build is untracked, so it must be removed explicitly; otherwise
# deleting branding/icon.ico would silently keep the old artwork.
$iconDir = Join-Path $HarnessRoot 'apps\desktop\build'
$iconTarget = Join-Path $iconDir 'icon.ico'
if (Test-Path -LiteralPath $iconTarget) { Remove-Item -LiteralPath $iconTarget -Force }

if (Test-Path -LiteralPath $IconSource) {
    New-Item -ItemType Directory -Force -Path $iconDir | Out-Null
    Copy-Item -LiteralPath $IconSource -Destination $iconTarget -Force
    $env:DSH_DESKTOP_ICON = $iconTarget
    Write-Host "icon:         $IconSource"
}
else {
    Remove-Item Env:\DSH_DESKTOP_ICON -ErrorAction SilentlyContinue
    Write-Warning 'branding/icon.ico not found; this build keeps the stock Electron icon.'
}

# ---------------------------------------------------------------------------
Write-Host '== [4/6] signing mode ==' -ForegroundColor Cyan
$signingInputs = @(
    'DSH_DESKTOP_WINDOWS_CER_FILE',
    'DSH_DESKTOP_WINDOWS_SIGNTOOL',
    'DSH_DESKTOP_WINDOWS_KEY_CONTAINER',
    'DSH_DESKTOP_WINDOWS_TOKEN_PIN'
)
$missing = @()
foreach ($name in $signingInputs) {
    if ([string]::IsNullOrWhiteSpace((Get-EnvironmentValue -Name $name))) { $missing += $name }
}

$mode = 'unsigned'
$signingNote = ''
if ($missing.Count -gt 0) {
    $signingNote = "not set: $($missing -join ', ')"
}
elseif (-not (Test-Path -LiteralPath $env:DSH_DESKTOP_WINDOWS_CER_FILE)) {
    $signingNote = "certificate file not found: $($env:DSH_DESKTOP_WINDOWS_CER_FILE)"
}
elseif (-not (Test-Path -LiteralPath $env:DSH_DESKTOP_WINDOWS_SIGNTOOL)) {
    $signingNote = "signtool not found: $($env:DSH_DESKTOP_WINDOWS_SIGNTOOL)"
}
elseif ($env:DSH_DESKTOP_WINDOWS_TOKEN_PIN -match '[\]"\r\n]') {
    $signingNote = 'the token PIN contains a forbidden ], quote, or line break'
}
else {
    $mode = 'signed'
}

# Unsigned support landed after the dsh-v0.1.5-rc.2 tag; older revisions can only build signed.
if ($mode -eq 'unsigned' -and -not $supportsUnsigned) {
    throw "revision '$Ref' does not support unsigned Windows builds (upstream added $UnsignedScriptName later). Use -Channel master, or supply the four DSH_DESKTOP_WINDOWS_* EV signing inputs."
}

if ($mode -eq 'signed') {
    if (-not (Get-EnvironmentValue -Name 'DSH_DESKTOP_AUTO_UPDATE_ENV')) {
        $env:DSH_DESKTOP_AUTO_UPDATE_ENV = 'test'
    }
    if ($env:DSH_DESKTOP_AUTO_UPDATE_ENV -eq 'test' -and
        [string]::IsNullOrWhiteSpace((Get-EnvironmentValue -Name 'DOWNLOAD_TEST_ORIGIN'))) {
        throw 'A signed release embeds an electron-updater feed. Set DOWNLOAD_TEST_ORIGIN to the HTTPS origin that will host it, or set DSH_DESKTOP_AUTO_UPDATE_ENV=production.'
    }
    Write-Host "mode: signed (EV)   update channel: $($env:DSH_DESKTOP_AUTO_UPDATE_ENV)" -ForegroundColor Green
}
else {
    Write-Host "mode: unsigned      reason: $signingNote" -ForegroundColor Yellow
    Write-Host '      An unsigned installer has no update feed and must be redistributed manually.' -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
Write-Host '== [5/6] packaging (builds the whole repository first; expect 30-60 minutes) ==' -ForegroundColor Cyan
if (-not $NoInstall) {
    Invoke-Native -File 'pnpm' -Arguments @('install', '--frozen-lockfile') -WorkingDirectory $HarnessRoot
}
# Prefer the documented, release-qualified root commands. Only the unpacked unsigned combination
# has no root script, so that one calls the desktop package script directly.
if (-not $Dir -and $mode -eq 'unsigned') {
    $packageArguments = @('run', $UnsignedScriptName)
}
elseif (-not $Dir) {
    $packageArguments = @('run', 'package:desktop:win:x64')
}
else {
    $packageArguments = @('--filter', '@deepseek-ai/dsh-desktop', 'run', 'package', '--', $TargetName)
    if ($mode -eq 'unsigned') { $packageArguments += '--unsigned' }
    $packageArguments += '--dir'
}
# Upstream package-target.ts re-invokes pnpm as `node $npm_execpath`, so npm_execpath must name a
# JavaScript file. pnpm 11 installs a platform binary and points npm_execpath at that .exe, which
# Node rejects with ERR_UNKNOWN_FILE_EXTENSION. pnpm preserves a pre-set npm_execpath, so point it
# at the JavaScript entry the workspace ships.
$pnpmEntry = Join-Path $HarnessRoot 'apps\desktop\node_modules\pnpm\bin\pnpm.mjs'
if (Test-Path -LiteralPath $pnpmEntry) {
    $env:npm_execpath = $pnpmEntry
    Write-Host "npm_execpath: $pnpmEntry"
}
Invoke-Native -File 'pnpm' -Arguments $packageArguments -WorkingDirectory $HarnessRoot

# ---------------------------------------------------------------------------
Write-Host '== [6/6] collecting artifacts ==' -ForegroundColor Cyan
$targetRoot = Join-Path $HarnessRoot "apps\desktop\.desktop-build\targets\$TargetName"
$artifactDir = if ($mode -eq 'unsigned') { Join-Path $targetRoot 'unsigned-artifacts' } else { Join-Path $targetRoot 'artifacts' }
if (-not (Test-Path -LiteralPath $artifactDir)) { throw "expected artifacts at $artifactDir but the directory does not exist" }

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
Get-ChildItem -LiteralPath $artifactDir -File |
    Where-Object { $_.Name -ne 'builder-effective-config.yaml' } |
    Copy-Item -Destination $outputRoot -Force

$info = [ordered]@{
    upstreamRef     = $Ref
    upstreamCommit  = $commit
    upstreamVersion = $upstreamVersion
    releaseMode     = $mode
    signingNote     = $signingNote
    appId           = $env:DSH_DESKTOP_APP_ID
    productName     = $env:DSH_DESKTOP_PRODUCT_NAME
    target          = $TargetName
    directory       = [bool]$Dir
    outputRoot      = $outputRoot
    builtAt         = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
}
Write-JsonFile -Value $info -Path (Join-Path $outputRoot 'build-info.json')
Write-JsonFile -Value $info -Path (Join-Path $DistRoot 'last-build.json')

if ($mode -eq 'signed' -and -not $Dir) {
    $feedDir = Join-Path $outputRoot 'feed\_\harness\desktop\stable\win-x64'
    New-Item -ItemType Directory -Force -Path $feedDir | Out-Null
    Get-ChildItem -LiteralPath $outputRoot -File |
        Where-Object { $_.Extension -in @('.exe', '.yml', '.blockmap') } |
        Copy-Item -Destination $feedDir -Force
    Write-Host ''
    Write-Host "update feed staged at $feedDir" -ForegroundColor Green
    Write-Host "sync it to $($env:DOWNLOAD_TEST_ORIGIN)/_/harness/desktop/stable/win-x64/ for electron-updater."
}

Write-Host ''
Write-Host "build complete: $outputRoot" -ForegroundColor Green
Get-ChildItem -LiteralPath $outputRoot -File |
    Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } } |
    Format-Table -AutoSize
