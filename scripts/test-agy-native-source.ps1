#requires -Version 7.0
param(
  [Parameter(Mandatory)][string] $Source,
  [string] $NodePath = (Get-Command node.exe -CommandType Application).Source
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$sourceRoot = (Resolve-Path -LiteralPath $Source).ProviderPath
$node = (Get-Item -LiteralPath $NodePath).FullName
$relative = [IO.Path]::GetRelativePath($project, $sourceRoot)
if ($relative -notlike 'tmp\*' -or $relative -match '(^|[\/])\.\.([\/]|$)') {
  throw '请将独立 DSH 源码放在本项目的 tmp 下。不能使用 Desktop 安装目录。'
}
# Do not stage files or run a generator through a junction to another installation.
foreach ($directory in @('.', 'packages', 'packages/api', 'packages/api/session-controller', 'packages/api/session-controller/tests')) {
  $path = Join-Path $sourceRoot $directory
  for ($item = Get-Item -LiteralPath $path; $null -ne $item; $item = $item.Parent) {
    if ($item -isnot [IO.DirectoryInfo] -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "验证目录包含非普通目录：$($item.FullName)"
    }
    if ($item.FullName -ieq $project) { break }
  }
}
$lock = Join-Path $sourceRoot 'pnpm-lock.yaml'
if ((Get-FileHash -LiteralPath $lock -Algorithm SHA256).Hash -cne 'C24A38565023F08480F3832A554A676AD7479D36C0868063C85AD66BA6D3E68A') {
  throw '锁文件与 DSH dsh-v0.2.2-rc.5 基线不同，请核对源码。'
}
if (!(Test-Path -LiteralPath (Join-Path $sourceRoot 'packages/api/session-controller/tests/session-turn-provider-fixture.ts') -PathType Leaf) -or
    !(Test-Path -LiteralPath (Join-Path $sourceRoot 'node_modules/vitest/vitest.mjs') -PathType Leaf)) {
  throw '需要已经应用两层补丁、按上游锁文件安装过依赖的隔离源码。'
}
$testDir = Join-Path $sourceRoot 'packages/api/session-controller/tests'
$stage = Join-Path $testDir 'subscriptions-agy'
$suite = Join-Path $testDir 'subscriptions-agy-native.host.spec.ts'
$config = Join-Path $sourceRoot 'agy-native-source.vitest.ts'
foreach ($target in @($stage, $suite, $config)) {
  if (Test-Path -LiteralPath $target) { throw "不覆盖已有测试文件：$target" }
}
$modules = @(
  'agy-acp-client.js', 'agy-compatibility.js', 'agy-identity.js', 'agy-ingress.js', 'agy-launch.js', 'agy-native-turn-host.js',
  'agy-session.js', 'agy-turn-context.js', 'agy-turn-executor.js', 'agy-turn-ledger.js', 'agy-turn-options.js', 'agy-turn-session.js'
)
$files = [Collections.Generic.List[string]]::new()
$dirs = [Collections.Generic.List[string]]::new()
$scratch = Join-Path $sourceRoot ('.agy-native-check-' + [guid]::NewGuid().ToString('N'))

function Add-Directory([string] $Path) {
  $null = New-Item -ItemType Directory -Path $Path
  $dirs.Add($Path)
}
function Add-Copy([string] $InputPath, [string] $OutputPath) {
  [IO.File]::Copy($InputPath, $OutputPath, $false)
  $files.Add($OutputPath)
}
function Invoke-Node([string[]] $Arguments) {
  $launch = [Diagnostics.ProcessStartInfo]::new($node)
  $launch.WorkingDirectory = $sourceRoot
  $launch.UseShellExecute = $false
  $launch.CreateNoWindow = $true
  $launch.RedirectStandardOutput = $true
  $launch.RedirectStandardError = $true
  $launch.StandardOutputEncoding = [Text.Encoding]::UTF8
  $launch.StandardErrorEncoding = [Text.Encoding]::UTF8
  $launch.Environment.Clear()
  foreach ($key in 'SYSTEMROOT','WINDIR','COMSPEC','PROCESSOR_ARCHITECTURE') {
    $value = [Environment]::GetEnvironmentVariable($key)
    if ($value) { $launch.Environment[$key] = $value }
  }
  $launch.Environment['PATH'] = "$(Split-Path -Parent $node);$env:SystemRoot\System32"
  foreach ($key in 'TEMP','TMP','TMPDIR') { $launch.Environment[$key] = $scratch }
  foreach ($key in 'HOME','USERPROFILE','APPDATA','LOCALAPPDATA') { $launch.Environment[$key] = Join-Path $scratch 'home' }
  $launch.Environment['DSH_HOME'] = Join-Path $scratch 'home\.dsh'
  $launch.Environment['DSH_AGENTS_HOME'] = Join-Path $scratch 'home\agents'
  $launch.Environment['DSH_SNAPSHOT'] = 'replay'
  $launch.Environment['NO_COLOR'] = '1'
  foreach ($arg in $Arguments) { $launch.ArgumentList.Add($arg) }
  $process = [Diagnostics.Process]::Start($launch)
  try {
    $out = $process.StandardOutput.ReadToEndAsync()
    $err = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    [Console]::Out.Write($out.GetAwaiter().GetResult())
    [Console]::Error.Write($err.GetAwaiter().GetResult())
    if ($process.ExitCode -ne 0) { throw "Node 退出码 $($process.ExitCode)：$($Arguments[0])" }
  } finally { $process.Dispose() }
}

try {
  Add-Directory $scratch
  Add-Directory (Join-Path $scratch 'home')
  Add-Directory $stage
  foreach ($file in $modules) { Add-Copy (Join-Path $project "src/$file") (Join-Path $stage $file) }
  Add-Copy (Join-Path $project 'tests/fixtures/agy-native-source.fixture.ts') $suite
  Add-Copy (Join-Path $project 'tests/fixtures/agy-native-source.vitest.ts') $config
  Invoke-Node @('--import', 'tsx/esm', 'scripts/generate-typert.ts')
  Invoke-Node @('node_modules/vitest/vitest.mjs', 'run', '--config', 'agy-native-source.vitest.ts', '--maxWorkers=1')
} finally {
  foreach ($path in $files) {
    $item = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
    if ($null -ne $item -and $item.FullName -ieq $path -and !$item.PSIsContainer -and
        !($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Remove-Item -LiteralPath $item.FullName }
  }
  # The fresh scratch contains only the fixtures' test profiles and tool caches.
  if ($dirs.Contains($scratch)) {
    $item = Get-Item -LiteralPath $scratch -ErrorAction SilentlyContinue
    if ($item -is [IO.DirectoryInfo] -and $item.FullName -ieq $scratch -and
        !($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      $entries = @(Get-ChildItem -LiteralPath $item.FullName -Force -Recurse)
      if (!@($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) {
        Remove-Item -LiteralPath $item.FullName -Recurse -Force
      }
    }
  }
  for ($index = $dirs.Count - 1; $index -ge 0; $index--) {
    $path = $dirs[$index]
    $item = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
    if ($null -eq $item -or $item.FullName -ine $path -or !$item.PSIsContainer -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
    if (@(Get-ChildItem -LiteralPath $item.FullName -Force).Count -eq 0) { Remove-Item -LiteralPath $item.FullName }
    else { Write-Warning "保留有内容的隔离测试目录供检查：$path" }
  }
}
