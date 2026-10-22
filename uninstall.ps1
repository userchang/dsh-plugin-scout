# dsh-plugin-scout 卸载脚本（幂等）
#
# 用法：powershell -ExecutionPolicy Bypass -File <插件目录>\uninstall.ps1 [-Profile desktop]
param([string]$Profile = 'web')

$ErrorActionPreference = 'Stop'

function Find-Dsh {
  $cmd = Get-Command dsh -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidate = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
  if (Test-Path $candidate) { return $candidate }
  throw '找不到 dsh 命令。'
}

$dsh = Find-Dsh
$homeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $homeDir "profiles\$Profile"
$env:NODE_OPTIONS = ''

# 1) 先让 pnpm 正常移除；失败（例如依赖已被手工摘掉）不影响后面的兜底。
#    注意：这里必须临时放宽 ErrorActionPreference，否则原生命令的非零退出会直接终止脚本。
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $dsh plugin --profile $Profile remove dsh-plugin-scout 2>$null | Out-Null
$ErrorActionPreference = $previous

# 2) 兜底：从 package.json 的 bundles / dependencies 里摘干净
$manifestPath = Join-Path $profileDir 'package.json'
if (Test-Path $manifestPath) {
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  $manifest.dsh.profile.bundles = @($manifest.dsh.profile.bundles | Where-Object { $_ -ne 'dsh-plugin-scout' })
  if ($manifest.dependencies) {
    $manifest.dependencies.PSObject.Properties.Remove('dsh-plugin-scout')
  }
  $json = $manifest | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText($manifestPath, $json, (New-Object Text.UTF8Encoding($false)))
}

# 3) 删除 node_modules 里的实体包
Remove-Item (Join-Path $profileDir 'node_modules\dsh-plugin-scout') -Recurse -Force -ErrorAction SilentlyContinue

# 4) 复核
$found = & $dsh --profile $Profile --dump-config 2>$null | Select-String -Pattern 'dsh-plugin-scout'
if ($found) {
  Write-Host '警告：dump-config 里仍能看到 dsh-plugin-scout，请检查 profile 的 cordis.patch.yml 是否有手工行。'
  exit 1
}
Write-Host '已卸载：dump-config 中不再包含 dsh-plugin-scout。'
Write-Host 'scout/config.yaml 与 data/backups/ 保持原样（插件不删用户数据）。'
