#requires -Version 7.0
<#
.SYNOPSIS
    从跟踪的上游修订构建 Windows x64 的 DeepSeek Harness 桌面安装包。

.DESCRIPTION
    把上游 deepseek-harness 检出到 ./harness，应用品牌覆盖层，然后走官方 apps/desktop 打包路径产出
    NSIS 安装包。

    签名模式是自动探测的，不需要手工切换：当四个 DSH_DESKTOP_WINDOWS_* 输入全部存在且有效时，产出
    EV 签名的发行版并附带 electron-updater 更新元数据；否则产出 unsigned 安装包，且不生成更新源。

.PARAMETER Ref
    要构建的上游 git 修订（tag、分支或 commit）。默认为最新的 dsh-v* tag。

.PARAMETER Channel
    any（默认）接受 dsh-v0.1.5-rc.2 这类预发布 tag；stable 只接受 dsh-v<主>.<次>.<修订>。

.PARAMETER Dir
    产出未打包的应用程序目录，而不是安装包。

.PARAMETER Force
    即使 dist/<版本>/ 已存在也强制重新构建。

.PARAMETER NoInstall
    跳过 harness 检出目录中的 pnpm install。
#>
[CmdletBinding()]
param(
    [string]$Ref,
    [ValidateSet('any', 'stable')][string]$Channel = 'any',
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

function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$File,
        [Parameter(Mandatory)][string[]]$Arguments,
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
    param([Parameter(Mandatory)][string[]]$Arguments)
    $output = & git -C $HarnessRoot @Arguments
    if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') exited with $LASTEXITCODE" }
    return @($output)
}

function Get-EnvironmentValue {
    param([Parameter(Mandatory)][string]$Name)
    return Get-Item -Path "Env:$Name" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Value
}

# ---------------------------------------------------------------------------
Write-Host '== [1/6] 上游检出 ==' -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath (Join-Path $HarnessRoot '.git'))) {
    Write-Host "cloning $HarnessUrl"
    Invoke-Native -File 'git' -Arguments @('clone', '--filter=blob:none', $HarnessUrl, $HarnessRoot)
}
Invoke-Native -File 'git' -Arguments @('-C', $HarnessRoot, 'fetch', 'origin', '--tags', '--prune', '--force')

if (-not $Ref) {
    $tags = Get-GitOutput -Arguments @('tag', '--list', 'dsh-v*', '--sort=-v:refname')
    if ($Channel -eq 'stable') { $tags = @($tags | Where-Object { $_ -match '^dsh-v\d+\.\d+\.\d+$' }) }
    if ($tags.Count -eq 0) { throw "没有匹配 channel '$Channel' 的 dsh-v* tag" }
    $Ref = $tags[0]
}
Write-Host "revision: $Ref"

# 覆盖层会弄脏工作树；每次构建都从干净的固定提交重新开始。这里只重置已跟踪文件，
# 不执行 git clean，避免误删检出目录中的未跟踪内容。
Invoke-Native -File 'git' -Arguments @('-C', $HarnessRoot, 'reset', '--hard', '--quiet')
Invoke-Native -File 'git' -Arguments @('-C', $HarnessRoot, 'checkout', '--quiet', '--detach', $Ref)

$upstreamVersion = (Get-Content -LiteralPath (Join-Path $HarnessRoot 'package.json') -Raw | ConvertFrom-Json).version
$commit = (Get-GitOutput -Arguments @('rev-parse', '--short', 'HEAD')) -join ''
Write-Host "upstream dsh version: $upstreamVersion ($commit)"

$outputRoot = Join-Path $DistRoot $upstreamVersion
if ((Test-Path -LiteralPath $outputRoot) -and -not $Force) {
    Write-Host "dist/$upstreamVersion 已存在；加 -Force 可重新构建" -ForegroundColor Yellow
    return
}

# ---------------------------------------------------------------------------
Write-Host '== [2/6] 品牌覆盖层 ==' -ForegroundColor Cyan
$patches = @(Get-ChildItem -LiteralPath $OverlayRoot -Filter '*.patch' | Sort-Object Name)
if ($patches.Count -eq 0) { throw "在 $OverlayRoot 中找不到任何覆盖补丁" }
foreach ($patch in $patches) {
    & git -C $HarnessRoot apply --3way --whitespace=nowarn $patch.FullName
    if ($LASTEXITCODE -ne 0) {
        throw "覆盖补丁 $($patch.Name) 应用失败：上游改动了被补丁覆盖的行。请更新该补丁后重试。"
    }
    Write-Host "applied $($patch.Name)"
}

# ---------------------------------------------------------------------------
Write-Host '== [3/6] 发行环境 ==' -ForegroundColor Cyan
if (-not (Get-EnvironmentValue -Name 'DSH_DESKTOP_APP_ID')) {
    $env:DSH_DESKTOP_APP_ID = 'com.example.dsh-desktop'
    Write-Warning "未设置 DSH_DESKTOP_APP_ID，暂用 $($env:DSH_DESKTOP_APP_ID)。请改成你自己的反向 DNS 标识。"
}
if ($env:DSH_DESKTOP_APP_ID -notmatch '^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$') {
    throw 'DSH_DESKTOP_APP_ID 必须是反向 DNS 标识，例如 com.yourorg.dsh'
}
if (-not (Get-EnvironmentValue -Name 'DSH_DESKTOP_PRODUCT_NAME')) {
    $env:DSH_DESKTOP_PRODUCT_NAME = 'DeepSeek Harness'
}
Write-Host "app id:       $($env:DSH_DESKTOP_APP_ID)"
Write-Host "product name: $($env:DSH_DESKTOP_PRODUCT_NAME)"

# 上一次构建复制进去的图标不会被 git 跟踪，必须显式清理，否则移除 branding/icon.ico 后仍会沿用旧图标。
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
    Write-Warning '找不到 branding/icon.ico，本次构建沿用 Electron 默认图标。'
}

# ---------------------------------------------------------------------------
Write-Host '== [4/6] 签名模式探测 ==' -ForegroundColor Cyan
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
    $signingNote = "未设置：$($missing -join ', ')"
}
elseif (-not (Test-Path -LiteralPath $env:DSH_DESKTOP_WINDOWS_CER_FILE)) {
    $signingNote = "证书文件不存在：$($env:DSH_DESKTOP_WINDOWS_CER_FILE)"
}
elseif (-not (Test-Path -LiteralPath $env:DSH_DESKTOP_WINDOWS_SIGNTOOL)) {
    $signingNote = "signtool 不存在：$($env:DSH_DESKTOP_WINDOWS_SIGNTOOL)"
}
elseif ($env:DSH_DESKTOP_WINDOWS_TOKEN_PIN -match '[\]"\r\n]') {
    $signingNote = 'Token PIN 含有不允许的 ]、引号或换行'
}
else {
    $mode = 'signed'
}

if ($mode -eq 'signed') {
    if (-not (Get-EnvironmentValue -Name 'DSH_DESKTOP_AUTO_UPDATE_ENV')) {
        $env:DSH_DESKTOP_AUTO_UPDATE_ENV = 'test'
    }
    if ($env:DSH_DESKTOP_AUTO_UPDATE_ENV -eq 'test' -and
        [string]::IsNullOrWhiteSpace((Get-EnvironmentValue -Name 'DOWNLOAD_TEST_ORIGIN'))) {
        throw '签名发行版会写入 electron-updater 更新源。请设置 DOWNLOAD_TEST_ORIGIN 为托管更新源的 HTTPS 源，或设置 DSH_DESKTOP_AUTO_UPDATE_ENV=production。'
    }
    Write-Host "mode: signed (EV)   更新通道: $($env:DSH_DESKTOP_AUTO_UPDATE_ENV)" -ForegroundColor Green
}
else {
    Write-Host "mode: unsigned      原因: $signingNote" -ForegroundColor Yellow
    Write-Host '      unsigned 安装包不含更新源，需要手动分发新版本。' -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
Write-Host '== [5/6] 打包（会先完整构建仓库，耗时较长）==' -ForegroundColor Cyan
if (-not $NoInstall) {
    Invoke-Native -File 'pnpm' -Arguments @('install', '--frozen-lockfile') -WorkingDirectory $HarnessRoot
}
$packageArguments = @('--dir', 'apps/desktop', 'run', 'package', '--', $TargetName)
if ($mode -eq 'unsigned') { $packageArguments += '--unsigned' }
if ($Dir) { $packageArguments += '--dir' }
Invoke-Native -File 'pnpm' -Arguments $packageArguments -WorkingDirectory $HarnessRoot

# ---------------------------------------------------------------------------
Write-Host '== [6/6] 收集产物 ==' -ForegroundColor Cyan
$targetRoot = Join-Path $HarnessRoot "apps\desktop\.desktop-build\targets\$TargetName"
$artifactDir = if ($mode -eq 'unsigned') { Join-Path $targetRoot 'unsigned-artifacts' } else { Join-Path $targetRoot 'artifacts' }
if (-not (Test-Path -LiteralPath $artifactDir)) { throw "预期产物目录不存在：$artifactDir" }

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
$info | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputRoot 'build-info.json') -Encoding utf8
$info | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $DistRoot 'last-build.json') -Encoding utf8

if ($mode -eq 'signed' -and -not $Dir) {
    $feedDir = Join-Path $outputRoot 'feed\_\harness\desktop\stable\win-x64'
    New-Item -ItemType Directory -Force -Path $feedDir | Out-Null
    Get-ChildItem -LiteralPath $outputRoot -File |
        Where-Object { $_.Extension -in @('.exe', '.yml', '.blockmap') } |
        Copy-Item -Destination $feedDir -Force
    Write-Host ''
    Write-Host "更新源已就绪：$feedDir" -ForegroundColor Green
    Write-Host "把它同步到 $($env:DOWNLOAD_TEST_ORIGIN)/_/harness/desktop/stable/win-x64/ 后，electron-updater 即可拉取。"
}

Write-Host ''
Write-Host "构建完成：$outputRoot" -ForegroundColor Green
Get-ChildItem -LiteralPath $outputRoot -File |
    Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } } |
    Format-Table -AutoSize
