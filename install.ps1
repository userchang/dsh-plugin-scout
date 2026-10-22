# dsh-plugin-scout 安装脚本（幂等）
#
# 为什么需要它：
#   pnpm 对本地目录依赖默认建 junction；当 profile 在 C: 而插件在 D: 时，
#   跨盘的 junction 建不出来，`dsh plugin add` 会留下"依赖已记录、node_modules 里没有"的状态。
#   本脚本在 add 之后补一次实体拷贝，保证 dump-config 能解析到包。
#
# 用法：powershell -ExecutionPolicy Bypass -File <插件目录>\install.ps1 [-Profile desktop]
param(
  [string]$Profile = 'web',
  [string]$PackageDir = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'

function Find-Dsh {
  $cmd = Get-Command dsh -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidate = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
  if (Test-Path $candidate) { return $candidate }
  throw '找不到 dsh 命令。请先按 DSH 文档把 dsh 加到 PATH，或修改本脚本里的路径。'
}

$dsh = Find-Dsh
$homeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $homeDir "profiles\$Profile"
if (-not (Test-Path $profileDir)) { throw "profile 不存在：$profileDir" }

$env:NODE_OPTIONS = ''   # 避免外部 preload 干扰 dsh

Write-Host "[1/4] 记录依赖：dsh plugin --profile $Profile add $PackageDir"
& $dsh plugin --profile $Profile add $PackageDir
if ($LASTEXITCODE -ne 0) {
  Write-Host "       add 返回 $LASTEXITCODE（通常是跨盘链接失败）；继续做实体拷贝兜底。"
}

Write-Host "[2/4] 确保 package.json 的依赖与 bundles 都有 dsh-plugin-scout"
$manifestPath = Join-Path $profileDir 'package.json'
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
if (-not $manifest.dependencies) {
  $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
}
if (-not $manifest.dependencies.'dsh-plugin-scout') {
  $manifest.dependencies | Add-Member -NotePropertyName 'dsh-plugin-scout' -NotePropertyValue "file:$($PackageDir -replace '\\','/')"
}
$bundles = @($manifest.dsh.profile.bundles)
if ($bundles -notcontains 'dsh-plugin-scout') {
  $manifest.dsh.profile.bundles = @($bundles) + 'dsh-plugin-scout'
}
$json = $manifest | ConvertTo-Json -Depth 20
[IO.File]::WriteAllText($manifestPath, $json, (New-Object Text.UTF8Encoding($false)))

Write-Host "[3/4] 确保 node_modules 里有实体包"
$modulesDir = Join-Path $profileDir 'node_modules'
$target = Join-Path $modulesDir 'dsh-plugin-scout'
New-Item -ItemType Directory -Force -Path $modulesDir | Out-Null
Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
# 整体覆盖：跨盘无法建链接，这里用实体拷贝；改完源码重跑本脚本即可刷新。
Copy-Item $PackageDir $target -Recurse -Force
Remove-Item (Join-Path $target 'lib\__pycache__') -Recurse -Force -ErrorAction SilentlyContinue
foreach ($junk in @('任务书.md', '进度.md', 'dsh-plugin-scout-1.0.0.tgz')) {
  Remove-Item (Join-Path $target $junk) -Force -ErrorAction SilentlyContinue
}

Write-Host "[4/4] 校验 --dump-config"
& $dsh --profile $Profile --dump-config | Select-String -Pattern 'dsh-plugin-scout' -Context 1,1
Write-Host ''
Write-Host '安装完成。重启 DSH（或让页面重连）后：'
Write-Host '  - 设置 → 情报员日报      配置渠道/凭据/定时'
Write-Host '  - 任意会话里可调用         scout_run_daily / scout_last_run / scout_test_channel'
