#requires -Version 7.0
[CmdletBinding()]
param(
  [ValidateSet('Prepare','Web','Stop')][string] $Action = 'Prepare',
  [string] $NodePath = (Get-Command node -CommandType Application -ErrorAction Stop).Source,
  [switch] $OpenBrowser
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$source = Join-Path $project 'tmp\dsh-rc5-acp-native\source'
$trial = Join-Path $project 'tmp\agy-native-trial'
$stage = Join-Path $source 'packages\api\session-controller\.agy-native-trial'
$executable = Join-Path $trial 'cli\agy.exe'
$expectedHash = '397f0acb4005232799ebea7d5691fd113be009695f1986321876a300bf80aec6'
$cliAreas = @{}
foreach ($part in 'home','local','roaming','scratch') { $cliAreas[$part] = Join-Path $trial $part }
$workspace = Join-Path $trial 'work'

function Assert-OrdinaryPath([string] $Path) {
  $absolute = [IO.Path]::GetFullPath($Path)
  if ($absolute -notmatch '^[a-zA-Z]:\\' -or $absolute -match '[\x00-\x1f]') { throw '需要本机绝对路径。' }
  $current = $absolute
  while ($current) {
    $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if ($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw "试用路径包含链接：$absolute" }
    $current = Split-Path -Parent $current
  }
  return $absolute
}

function New-OwnedDirectory([string] $Path) {
  if (!(Test-Path -LiteralPath $Path)) {
    [void](Assert-OrdinaryPath (Split-Path -Parent $Path))
    [void](New-Item -ItemType Directory -Path $Path)
  }
  $absolute = Assert-OrdinaryPath $Path
  if (!(Get-Item -LiteralPath $absolute -Force).PSIsContainer) { throw "需要普通目录：$absolute" }
}

function Remove-RunFile([string] $Name) {
  if ($Name -notin @('ready.json','running.json','stop')) { throw '未知试用运行文件。' }
  $target = Join-Path $stage $Name
  if (Test-Path -LiteralPath $target) {
    $absolute = Assert-OrdinaryPath $target
    if ($absolute -ine $target -or (Get-Item -LiteralPath $absolute).PSIsContainer) { throw '运行文件身份变化。' }
    Remove-Item -LiteralPath $absolute
  }
}

# Drain stderr without retaining logs. Only fixed, pre-login boot milestones may leave the pipe.
function Read-BootProgress($Reader, $State) {
  while ($null -ne $State.line -and $State.line.IsCompleted) {
    $message = $State.line.GetAwaiter().GetResult()
    if ($null -eq $message) { $State.line = $null; return }
    $State.line = $Reader.ReadLineAsync()
    if (!$State.boot) { continue }
    if ($message -cmatch '^agy-trial:(import|apply|inspect|inspected|workspace|waiting-ready|ready)$') {
      "独立宿主启动阶段：$($Matches[1])"
    } elseif ($message -cmatch '^dsh: disabling profile plugin row "agy-native-trial":') {
      '独立宿主被 DSH 版本检查禁用。'
    } elseif ($message -cmatch '^([\w-]+) \(') {
      $row = $Matches[1]
      if ($row -notin @('agy-native-trial','agent-loop','llm','session-persistence-jsonl','storage-domain','session-controller','workspace','working-directory','connection','web-server','web-runtime','web-startup','modules','agent','agents','workspace-controller')) { continue }
      $missing = foreach ($service in 'agentLoop','agents','appExit','appReady','connection','llm','sessionController','sessionPersistence','sessions','storageDomain','webServer','workspaceRegistry','workingDirectory','webStartup','storage','rpc') {
        if ($message -cmatch ('pending \(waiting for.*\b'+$service+'\b')) { $service }
      }
      if ($message -cmatch 'pending \(waiting for') { "等待服务：$row / $($missing -join ', ')" } else { "插件激活失败：$row" }
      $State.controllerFailure = $row -ceq 'session-controller' -and $message -cnotmatch 'pending \(waiting for'
      if ($State.controllerFailure) {
        if ($message -cmatch "Cannot find package '(@deepseek-ai/[a-z-]+|zod|mime-types)' imported from") { "会话服务缺少包：$($Matches[1])" }
        foreach ($kind in 'failed to import','ERR_MODULE_NOT_FOUND','Cannot find package','Cannot find module','ENOENT','not registered','already registered','access to service','TypeError','SyntaxError','ReferenceError','ValidationError','Remote namespace','SQLITE') {
          if ($message.Contains($kind)) { "会话服务诊断：$kind" }
        }
      }
      if ($row -ceq 'agy-native-trial') { $State.inactive = $true }
    } elseif ($State.controllerFailure -and $message -cmatch '[/\\]packages[/\\]([a-z][a-z-]+)[/\\]([a-z][a-z-]+)[/\\]lib[/\\]index\.js:(\d{1,6}):(\d{1,6})\)?$') {
      "会话服务调用位置：$($Matches[1])/$($Matches[2]) $($Matches[3]):$($Matches[4])"
    } elseif ($message -cmatch '^dsh: (warning: [0-9]+ entr|startup failed:)') { 'DSH 报告部分插件未激活。' }
  }
}

function Start-TrialWeb([string] $File, [string[]] $Arguments) {
  $info = [Diagnostics.ProcessStartInfo]::new($File)
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.WorkingDirectory = $workspace
  $info.Environment.Clear()
  foreach ($key in 'SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','SYSTEMDRIVE','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS') {
    $value = [Environment]::GetEnvironmentVariable($key)
    if ($value) { $info.Environment[$key] = $value }
  }
  $dshHome = Join-Path $stage 'home'
  $info.Environment['PATH'] = "$(Split-Path -Parent $File);$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
  foreach ($key in 'HOME','USERPROFILE','LOCALAPPDATA','APPDATA') { $info.Environment[$key] = $dshHome }
  foreach ($key in 'TEMP','TMP','TMPDIR') { $info.Environment[$key] = Join-Path $stage 'scratch' }
  $info.Environment['DSH_HOME'] = Join-Path $dshHome '.dsh'
  $info.Environment['DSH_AGENTS_HOME'] = Join-Path $dshHome 'agents'
  $info.Environment['DSH_BUNDLED_SKILL_DIR'] = Join-Path $dshHome 'skills'
  $info.Environment['DSH_TELEMETRY_DISABLED'] = '1'
  $info.Environment['AGY_CLI_DISABLE_AUTO_UPDATE'] = 'true'
  $info.Environment['DSH_AGY_TRIAL_STARTUP'] = '1'
  $info.Environment['NO_COLOR'] = '1'
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = [Text.Encoding]::UTF8
  $info.StandardErrorEncoding = [Text.Encoding]::UTF8
  foreach ($argument in $Arguments) { [void]$info.ArgumentList.Add($argument) }
  return [Diagnostics.Process]::Start($info)
}

[void](Assert-OrdinaryPath $project)
[void](Assert-OrdinaryPath $trial)
$owner = Join-Path $trial 'owner.json'
[void](Assert-OrdinaryPath $owner)
$identity = [IO.File]::ReadAllText($owner) | ConvertFrom-Json
if ($identity.kind -cne 'subscriptions-agy-native-trial' -or $identity.version -ne 1) { throw '试用目录归属不符。' }
[void](Assert-OrdinaryPath $source)
foreach ($file in 'apps\cli\lib\bin.js','apps\web\dist\index.html','.dsh-build\client-build-environment.json') {
  [void](Assert-OrdinaryPath (Join-Path $source $file))
}
if ((Get-FileHash -LiteralPath (Join-Path $source 'pnpm-lock.yaml') -Algorithm SHA256).Hash -cne
    'C24A38565023F08480F3832A554A676AD7479D36C0868063C85AD66BA6D3E68A') { throw '隔离 DSH 依赖版本不符。' }
$node = Assert-OrdinaryPath $NodePath
[void](Assert-OrdinaryPath $executable)
if ((Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedHash) {
  throw '官方 agy 程序已变化；停止启动，请重新核验版本。'
}
$signature = Get-AuthenticodeSignature -LiteralPath $executable
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Google LLC(,|$)') {
  throw '官方 agy 签名不符。'
}

if ($Action -eq 'Stop') {
  [void](Assert-OrdinaryPath $stage)
  $running = Join-Path $stage 'running.json'
  if (!(Test-Path -LiteralPath $running -PathType Leaf)) { throw '没有本次试用的运行记录。' }
  [void](Assert-OrdinaryPath $running)
  $record = [IO.File]::ReadAllText($running) | ConvertFrom-Json
  if ($record.kind -cne 'agy-native-trial-web' -or $record.stage -ine $stage) { throw '运行记录归属不符。' }
  $process = Get-Process -Id $record.pid -ErrorAction Stop
  if ($process.Path -ine $node -or $process.StartTime.ToUniversalTime().Ticks -ne $record.startedTicks) {
    throw '运行进程身份已变化，未停止任何进程。'
  }
  $stopFile = Join-Path $stage 'stop'
  if (Test-Path -LiteralPath $stopFile) { [void](Assert-OrdinaryPath $stopFile) }
  [IO.File]::WriteAllText($stopFile, '')
  '已请求停止独立试用页面。'
  return
}

New-OwnedDirectory $stage
$stageOwner = Join-Path $stage 'owner.json'
if (!(Test-Path -LiteralPath $stageOwner)) {
  if (@(Get-ChildItem -LiteralPath $stage -Force).Count) { throw '试用宿主目录已有未知内容。' }
  [IO.File]::WriteAllText($stageOwner, '{"kind":"subscriptions-agy-native-trial-host","version":1}')
}
[void](Assert-OrdinaryPath $stageOwner)
$stageIdentity = [IO.File]::ReadAllText($stageOwner) | ConvertFrom-Json
if ($stageIdentity.kind -cne 'subscriptions-agy-native-trial-host' -or $stageIdentity.version -ne 1) { throw '试用宿主目录归属不符。' }
$lockPath = Join-Path $stage 'active.lock'
if (Test-Path -LiteralPath $lockPath) { [void](Assert-OrdinaryPath $lockPath) }
try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
catch { throw '另一个登录或网页试用还在运行，请先关闭它。' }
$child = $null
$ownsRun = $false
try {
  if (Test-Path -LiteralPath (Join-Path $stage 'running.json')) {
    throw '上次试用没有正常清理运行记录；先核对旧进程，不自动重启。'
  }
  foreach ($directory in @($cliAreas.Values) + @($workspace, (Join-Path $stage 'home'), (Join-Path $stage 'scratch'), (Join-Path $stage 'runtime'))) {
    New-OwnedDirectory $directory
  }
  $settingsDir = Join-Path $cliAreas.home '.gemini'
  New-OwnedDirectory $settingsDir
  $settingsDir = Join-Path $settingsDir 'antigravity-cli'
  New-OwnedDirectory $settingsDir
  $settingsFile = Join-Path $settingsDir 'settings.json'
  if (!(Test-Path -LiteralPath $settingsFile)) {
    $settings = @{ agentMode=''; toolPermission='strict'; allowNonWorkspaceAccess=$false; enableTerminalSandbox=$true;
      permissions=@{allow=@(); ask=@(); deny=@('read_file(*)','write_file(*)','read_url(*)','execute_url(*)','command(*)','mcp(*)')}; useG1Credits=$false }
    [IO.File]::WriteAllText($settingsFile, ($settings | ConvertTo-Json -Depth 5))
  }
  [void](Assert-OrdinaryPath $settingsFile)
  $settings = [IO.File]::ReadAllText($settingsFile) | ConvertFrom-Json
  $unexpectedFalseDefault = @('allowNonWorkspaceAccess','useG1Credits' | Where-Object {
    $property = $settings.PSObject.Properties[$_]
    $null -ne $property -and ($property.Value -isnot [bool] -or $property.Value -ne $false)
  }).Count -gt 0
  if ($settings.toolPermission -cne 'strict' -or $unexpectedFalseDefault -or
      @('read_file(*)','write_file(*)','read_url(*)','execute_url(*)','command(*)','mcp(*)' | Where-Object { $_ -cnotin $settings.permissions.deny }).Count) {
    throw '试用工具限制已变化；没有覆盖现有设置，请人工核对。'
  }
  # The profile resolver walks upwards from its include directory. End its package scope here,
  # before the enclosing source package's @deepseek-ai/dsh-api-session-controller self-export.
  $stageManifest = Join-Path $stage 'package.json'
  $scopeManifest = '{"private":true,"type":"module"}'
  if (Test-Path -LiteralPath $stageManifest) {
    [void](Assert-OrdinaryPath $stageManifest)
    if ([IO.File]::ReadAllText($stageManifest) -cne $scopeManifest) { throw '试用宿主包边界已变化。' }
  } else { [IO.File]::WriteAllText($stageManifest, $scopeManifest) }
  $runtime = Join-Path $stage 'runtime'
  foreach ($module in 'agy-acp-client.js','agy-compatibility.js','agy-identity.js','agy-ingress.js','agy-launch.js','agy-native-turn-host.js',
      'agy-session.js','agy-turn-context.js','agy-turn-executor.js','agy-turn-ledger.js','agy-turn-options.js','agy-turn-session.js') {
    $from = Assert-OrdinaryPath (Join-Path $project "src\$module")
    $to = Join-Path $runtime $module
    if (Test-Path -LiteralPath $to) { [void](Assert-OrdinaryPath $to) }
    [IO.File]::Copy($from, $to, $true)
  }
  $entries = @{'agy-native-trial.host.mjs'='trial.host.mjs'; 'agy-native-trial.auth.mjs'='agy-native-trial.auth.mjs'; 'agy-native-trial.client.js'='trial.client.js'}
  foreach ($entry in $entries.GetEnumerator()) {
    $from = Assert-OrdinaryPath (Join-Path $PSScriptRoot $entry.Key)
    $to = Join-Path $runtime $entry.Value
    if (Test-Path -LiteralPath $to) { [void](Assert-OrdinaryPath $to) }
    [IO.File]::Copy($from, $to, $true)
  }
  $hostTarget = Join-Path $runtime 'trial.host.mjs'
  $modulePackage = Join-Path $runtime 'package.json'
  if (Test-Path -LiteralPath $modulePackage) { [void](Assert-OrdinaryPath $modulePackage) }
  $manifest = @{name='dsh-agy-native-trial'; version='0.0.0'; private=$true; type='module';
    exports=@{'.'='./trial.host.mjs'; './client'='./trial.client.js'; './package.json'='./package.json'};
    dsh=@{client=@{platform='web'; inject=@('@deepseek-ai/dsh-client-ui-settings-models','@deepseek-ai/dsh-client-locale')}}}
  [IO.File]::WriteAllText($modulePackage, ($manifest | ConvertTo-Json -Depth 5))
  $overlayPath = Join-Path $stage 'trial.patch.yml'
  $overlay = @(
    @{id='hmr'; disabled=$true}, @{id='llm-deepseek'; disabled=$true}, @{id='llm-deepseek-account'; disabled=$true},
    @{id='agent-default-model'; config=@{provider='trial-idle'; model='select-antigravity'}},
    @{id='session-title-llm'; disabled=$true}, @{id='session-log-deepseek'; config=@{enabled=$false}},
    @{id='session-telemetry-otel'; disabled=$true}, @{id='desktop-product-telemetry'; disabled=$true}, @{id='product-analytics'; disabled=$true},
    @{id='session-query-sqlite'; config=@{path=':memory:'; openAt='first-search'}},
    @{id='ui-settings-general'; config=@{welcomeNoticeVersion='2026-09-28.1'}},
    @{id='ui-plugin-manager'; config=@{registryProbeEnabled=$false}},
    @{id='open-in-app'; disabled=$true}, @{id='ui-open-in-app'; disabled=$true},
    @{id='workspace-controller'; config=@{documentsDirectory=(Join-Path $stage 'Documents')}},
    @{id='web-runtime'; config=@{surfaceContext=$true; printUrl=$false; openBrowser=$false}},
    @{insert=@(@{id='agy-native-trial'; name=([Uri]::new($hostTarget).AbsoluteUri); config=@{
      root=$stage; workspace=$workspace; executable=$executable; cliAreas=$cliAreas }})}
  )
  if (Test-Path -LiteralPath $overlayPath) { [void](Assert-OrdinaryPath $overlayPath) }
  [IO.File]::WriteAllText($overlayPath, ($overlay | ConvertTo-Json -Depth 10 -AsArray))

  if ($Action -eq 'Prepare') {
    '独立试用文件已准备。日用 DSH 未修改。'
    return
  }
  Remove-RunFile 'stop'
  Remove-RunFile 'ready.json'
  $arguments = @((Join-Path $source 'apps\cli\lib\bin.js'), '--profile','web',
    '--patch',(Join-Path $source 'apps\web\tests\pin-browse-picker.overlay.yml'), '--patch',$overlayPath,
    '--host','127.0.0.1','--port','0','--no-open')
  $child = Start-TrialWeb $node $arguments
  $stdout = $child.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
  $progressState = @{boot=$true; line=$child.StandardError.ReadLineAsync()}
  [IO.File]::WriteAllText((Join-Path $stage 'running.json'), (@{kind='agy-native-trial-web';stage=$stage;pid=$child.Id;
    startedTicks=$child.StartTime.ToUniversalTime().Ticks} | ConvertTo-Json -Compress))
  $ownsRun = $true
  $readyFile = Join-Path $stage 'ready.json'
  $deadline = [datetime]::UtcNow.AddSeconds(240)
  while (!(Test-Path -LiteralPath $readyFile -PathType Leaf)) {
    Read-BootProgress $child.StandardError $progressState
    if ($progressState.inactive) { throw '独立试用插件未激活，已停止本次宿主。' }
    if ($child.WaitForExit(150)) { throw '试用页面未能启动。未打印进程日志，避免泄露登录信息。' }
    if ([datetime]::UtcNow -ge $deadline) { throw '试用页面在 240 秒内未就绪。' }
  }
  [void](Assert-OrdinaryPath $readyFile)
  $ready = [IO.File]::ReadAllText($readyFile) | ConvertFrom-Json
  if ($ready.status -cne 'ready') { throw '试用 Host 无法准备本机设置页面。没有发送模型消息。' }
  $base = [Uri]$ready.base
  $launch = [Uri]$ready.launchUrl
  if ($base.Scheme -cne 'http' -or $base.Host -cne '127.0.0.1' -or
      $base.AbsolutePath -cne '/' -or $base.Query -or $base.Fragment -or $base.UserInfo -or
      $launch.GetLeftPart([UriPartial]::Authority) -cne $base.GetLeftPart([UriPartial]::Authority) -or
      $launch.AbsolutePath -cne '/' -or !$launch.Query -or $launch.Fragment -or $launch.UserInfo) { throw '试用页面地址身份不符。' }
  $listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $base.Port -State Listen -ErrorAction Stop)
  if ($child.Id -notin $listeners.OwningProcess) { throw '试用端口进程不符。' }
  "独立试用已启动：$($ready.base)"
  '原生设置的模型页可发起 Google 官方授权。启动不会自动登录或发送模型消息。'
  if ($OpenBrowser) {
    try { Start-Process -FilePath $ready.launchUrl | Out-Null }
    catch { throw '无法打开默认浏览器；未输出带认证参数的启动链接。' }
  } else { '添加 -OpenBrowser 可在默认浏览器打开已授权的测试页面。' }
  '保持此终端运行；另一个终端执行 -Action Stop 可停止页面。'
  $progressState.boot = $false
  $end = [datetime]::UtcNow.AddHours(2)
  while (!$child.WaitForExit(500)) {
    Read-BootProgress $child.StandardError $progressState
    if ([datetime]::UtcNow -ge $end) { throw '独立试用达到两小时上限，已请求结束。' }
  }
  if ($child.ExitCode) { throw "试用进程已退出，退出码 $($child.ExitCode)。" }
} finally {
  if ($null -ne $child) {
    if (!$child.HasExited) { $child.Kill($true); $child.WaitForExit() }
    $child.Dispose()
  }
  if ($ownsRun) {
    Remove-RunFile 'running.json'
    Remove-RunFile 'ready.json'
    Remove-RunFile 'stop'
  }
  $lock.Dispose()
}
