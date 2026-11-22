#requires -Version 7.0
param(
  [Parameter(Mandatory)][string] $Source,
  [Parameter(Mandatory)][string] $BrowserArtifacts,
  [string] $NodePath = (Get-Command node.exe -CommandType Application).Source
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$sourceRoot = (Resolve-Path -LiteralPath $Source).ProviderPath
$relative = [IO.Path]::GetRelativePath($project, $sourceRoot)
if ($relative -notlike 'tmp\*' -or $relative -match '(^|[\/])\.\.([\/]|$)') {
  throw '需要使用本仓库 tmp 下的独立 DSH 源码。'
}
$parent = Join-Path $sourceRoot 'packages\api\session-controller'
for ($item = Get-Item -LiteralPath $parent; $null -ne $item; $item = $item.Parent) {
  if ($item -isnot [IO.DirectoryInfo] -or $item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
    throw "验证路径包含非普通目录：$($item.FullName)"
  }
  if ($item.FullName -ieq $project) { break }
}
$lock = Join-Path $sourceRoot 'pnpm-lock.yaml'
if ((Get-FileHash -LiteralPath $lock -Algorithm SHA256).Hash -cne 'C24A38565023F08480F3832A554A676AD7479D36C0868063C85AD66BA6D3E68A') {
  throw '需要 DSH dsh-v0.2.2-rc.5 锁定依赖。'
}
foreach ($file in @('apps/cli/lib/bin.js', 'apps/web/dist/index.html', '.dsh-build/client-build-environment.json', 'packages/api/session-controller/tests/session-turn-provider-fixture.ts')) {
  if (!(Test-Path -LiteralPath (Join-Path $sourceRoot $file) -PathType Leaf)) { throw "需要先应用两层补丁并构建：$file" }
}
$artifacts = (Resolve-Path -LiteralPath $BrowserArtifacts).ProviderPath
for ($item = Get-Item -LiteralPath $artifacts -Force; $null -ne $item; $item = $item.Parent) {
  if ($item -isnot [IO.DirectoryInfo] -or $item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
    throw "浏览器临时文件目录包含非普通目录：$($item.FullName)"
  }
}
$runName = 'agy-native-web-' + [guid]::NewGuid().ToString('N')
$stage = Join-Path $parent ('.' + $runName)
$handoff = Join-Path $artifacts $runName
$node = (Get-Item -LiteralPath $NodePath).FullName
$process = $null
$stdout = $null
$stderr = $null
$ownsStage = $false
$ownsHandoff = $false
try {
  $null = New-Item -ItemType Directory -Path $stage
  $ownsStage = $true
  $null = New-Item -ItemType Directory -Path $handoff
  $ownsHandoff = $true
  $homeDir = Join-Path $stage 'home'
  $work = Join-Path $stage 'AgyTestWorkspace'
  $scratch = Join-Path $stage 'scratch'
  $null = New-Item -ItemType Directory -Path $homeDir,$work,$scratch
  foreach ($module in @(
      'agy-acp-client.js', 'agy-compatibility.js', 'agy-identity.js', 'agy-ingress.js', 'agy-launch.js', 'agy-native-turn-host.js',
      'agy-session.js', 'agy-turn-context.js', 'agy-turn-executor.js', 'agy-turn-ledger.js', 'agy-turn-options.js', 'agy-turn-session.js')) {
    [IO.File]::Copy((Join-Path $project "src/$module"), (Join-Path $stage $module), $false)
  }
  [IO.File]::Copy((Join-Path $project 'tests/fixtures/agy-native-web.host.mjs'), (Join-Path $stage 'fixture.mjs'), $false)
  [IO.File]::Copy((Join-Path $project 'tests/fixtures/agy-native-web.browser.js'), (Join-Path $stage 'browser-template.js'), $false)
  [IO.File]::WriteAllText((Join-Path $stage 'package.json'), '{"type":"module","private":true}')
  $fixture = [Uri]::new((Join-Path $stage 'fixture.mjs')).AbsoluteUri
  $overlays = @(
    @{ id='hmr'; disabled=$true },
    @{ id='llm-deepseek'; disabled=$true },
    @{ id='llm-deepseek-account'; disabled=$true },
    @{ id='agent-default-model'; config=@{ provider='ordinary-fixture'; model='ordinary-web' } },
    @{ id='session-title-llm'; disabled=$true },
    @{ id='session-log-deepseek'; config=@{ enabled=$false } },
    @{ id='session-telemetry-otel'; disabled=$true },
    @{ id='session-query-sqlite'; config=@{ path=':memory:'; openAt='first-search' } },
    @{ id='ui-settings-general'; config=@{ welcomeNoticeVersion='2026-09-28.1' } },
    @{ id='ui-plugin-manager'; config=@{ registryProbeEnabled=$false } },
    @{ id='open-in-app'; disabled=$true },
    @{ id='ui-open-in-app'; disabled=$true },
    @{ id='workspace-controller'; config=@{ documentsDirectory=(Join-Path $stage 'Documents') } },
    @{ id='web-runtime'; config=@{ surfaceContext=$true; printUrl=$false; openBrowser=$false } },
    @{ insert=@(@{ id='agy-web-fixture'; name=$fixture; config=@{ root=$stage; workspace=$work } }) }
  )
  $patch = Join-Path $stage 'preview.patch.yml'
  [IO.File]::WriteAllText($patch, ($overlays | ConvertTo-Json -Depth 8 -AsArray))
  $launch = [Diagnostics.ProcessStartInfo]::new($node)
  $launch.UseShellExecute = $false
  $launch.CreateNoWindow = $true
  $launch.RedirectStandardOutput = $true
  $launch.RedirectStandardError = $true
  $launch.StandardOutputEncoding = [Text.Encoding]::UTF8
  $launch.StandardErrorEncoding = [Text.Encoding]::UTF8
  $launch.WorkingDirectory = $work
  $launch.Environment.Clear()
  foreach ($key in 'SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','SYSTEMDRIVE','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS') {
    $value = [Environment]::GetEnvironmentVariable($key)
    if ($value) { $launch.Environment[$key] = $value }
  }
  $launch.Environment['PATH'] = "$(Split-Path -Parent $node);$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
  foreach ($key in 'TEMP','TMP','TMPDIR') { $launch.Environment[$key] = $scratch }
  foreach ($key in 'HOME','USERPROFILE','LOCALAPPDATA','APPDATA') { $launch.Environment[$key] = $homeDir }
  $launch.Environment['DSH_HOME'] = Join-Path $homeDir '.dsh'
  $launch.Environment['DSH_AGENTS_HOME'] = Join-Path $homeDir 'agents'
  $launch.Environment['DSH_BUNDLED_SKILL_DIR'] = Join-Path $homeDir 'skills'
  $launch.Environment['DSH_TELEMETRY_DISABLED'] = '1'
  $launch.Environment['NO_COLOR'] = '1'
  foreach ($arg in @((Join-Path $sourceRoot 'apps/cli/lib/bin.js'), '--profile', 'web',
      '--patch', (Join-Path $sourceRoot 'apps/web/tests/pin-browse-picker.overlay.yml'), '--patch', $patch,
      '--host', '127.0.0.1', '--port', '0', '--no-open')) { $launch.ArgumentList.Add($arg) }
  "Isolated Web fixture: $stage"
  $process = [Diagnostics.Process]::Start($launch)
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  $deadline = [datetime]::UtcNow.AddSeconds(240)
  "Starting built CLI (fixture PID $($process.Id)); waiting for the test plugin and listener."
  $ready = Join-Path $stage 'ready'
  while (!(Test-Path -LiteralPath $ready -PathType Leaf)) {
    if ($process.WaitForExit(150)) { throw "DSH Web 在准备页面前退出：$($process.ExitCode)" }
    if ([datetime]::UtcNow -ge $deadline) { throw 'DSH Web 未在 240 秒内完成启动。' }
  }
  $url = [IO.File]::ReadAllText($ready).Trim()
  if ($url -cnotmatch '^http://127\.0\.0\.1:[0-9]{1,5}$') { throw '测试地址不属于隔离监听器。' }
  $own = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort ([Uri]$url).Port -State Listen -ErrorAction Stop
  if ($process.Id -notin $own.OwningProcess) { throw '测试监听器进程不匹配。' }
  $browserProgram = Join-Path $handoff 'browser-run.js'
  [IO.File]::Copy((Join-Path $stage 'browser-run.js'), $browserProgram, $false)
  "Ready (fixture PID $($process.Id)): $url"
  "Playwright MCP filename: $browserProgram"
  "End by creating the stop file in the fixture directory."
  if (!$process.WaitForExit(720000)) { throw '隔离网页测试超过 12 分钟。' }
  if ($process.ExitCode) { throw "DSH Web 退出码：$($process.ExitCode)" }
  'Isolated DSH Web stopped.'
} finally {
  if ($null -ne $process) {
    if (!$process.HasExited) { $process.Kill($true); $process.WaitForExit() }
    foreach ($stream in @($stdout, $stderr)) {
      if ($null -ne $stream -and $stream.Wait(2000)) {
        # The normal Web URL announcement is disabled. Do not print any URL queries.
        $stream.Result -replace '(https?://[^\s?"'']+)\?[^\s"'']+', '$1?[redacted]' | Write-Output
      }
    }
    $process.Dispose()
  }
  if ($ownsHandoff) {
    $item = Get-Item -LiteralPath $handoff -Force
    if ($item -isnot [IO.DirectoryInfo] -or $item.FullName -ine $handoff -or $item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
      throw "浏览器交接目录身份变化，未清理：$handoff"
    }
    $files = @(Get-ChildItem -LiteralPath $handoff -Force)
    if ($files.Count -gt 1 -or ($files.Count -eq 1 -and ($files[0].Name -cne 'browser-run.js' -or $files[0].PSIsContainer -or
        $files[0].Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)))) { throw "浏览器交接目录内容已变更：$handoff" }
    foreach ($file in $files) { Remove-Item -LiteralPath $file.FullName }
    Remove-Item -LiteralPath $handoff
  }
  if ($ownsStage) {
    $item = Get-Item -LiteralPath $stage -Force
    if ($item -isnot [IO.DirectoryInfo] -or $item.FullName -ine $stage -or $item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) -or
        @(Get-ChildItem -LiteralPath $stage -Force -Recurse -Attributes ReparsePoint).Count) {
      throw "测试目录身份变化，未清理：$stage"
    }
    Remove-Item -LiteralPath $item.FullName -Force -Recurse
  }
}
