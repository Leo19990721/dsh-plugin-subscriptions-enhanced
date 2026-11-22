#requires -Version 7.0
# Produce a Playwright MCP program for this owned fixture; never copy the private launch query into the program.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('browser','handoff')][string] $Kind,
  [Parameter(Mandatory)][string] $ArtifactDirectory,
  [string] $NodePath = (Get-Command node -ErrorAction Stop).Source,
  [switch] $CaptureCards
)
$ErrorActionPreference = 'Stop'
function Resolve-Ordinary([string] $Path) {
  $item = Get-Item -LiteralPath $Path -Force
  $current = $item
  while ($null -ne $current) {
    if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '试用交接路径经过重解析点。' }
    $current = if ($current.PSIsContainer) { $current.Parent } else { $current.Directory }
  }
  return $item.FullName
}
$project = Resolve-Ordinary (Split-Path -Parent $PSScriptRoot)
$stage = Resolve-Ordinary (Join-Path $project 'tmp/dsh-rc5-acp-native/source/packages/api/session-controller/.agy-native-trial')
$owner = [IO.File]::ReadAllText((Resolve-Ordinary (Join-Path $stage 'owner.json'))) | ConvertFrom-Json
if ($owner.kind -cne 'subscriptions-agy-native-trial-host' -or $owner.version -ne 1) { throw '试用目录归属不符。' }
$record = [IO.File]::ReadAllText((Resolve-Ordinary (Join-Path $stage 'running.json'))) | ConvertFrom-Json
if ($record.kind -cne 'agy-native-trial-web' -or $record.stage -ine $stage) { throw '试用进程归属不符。' }
$process = Get-Process -Id $record.pid
if ($process.Path -ine (Resolve-Ordinary $NodePath) -or $process.StartTime.ToUniversalTime().Ticks -ne $record.startedTicks) { throw '试用进程身份不符。' }
$readyFile = Resolve-Ordinary (Join-Path $stage 'ready.json')
$ready = [IO.File]::ReadAllText($readyFile) | ConvertFrom-Json
if ($ready.status -cne 'ready' -or $ready.base -cnotmatch '^http://127\.0\.0\.1:([0-9]{1,5})$') { throw '试用地址不符。' }
$port = [int]$Matches[1]
if ($port -lt 1 -or $port -gt 65535 -or $ready.launchUrl -isnot [string] -or !$ready.launchUrl.StartsWith("$($ready.base)/?")) { throw '试用地址不符。' }
$listeners = @(Get-NetTCPConnection -LocalPort $port -LocalAddress '127.0.0.1' -State Listen)
if ($process.Id -notin $listeners.OwningProcess) { throw '试用监听器身份变化。' }
$templateFile = Resolve-Ordinary (Join-Path $project "tests/fixtures/agy-native-trial.$Kind.js")
$source = [IO.File]::ReadAllText($templateFile)
$marker = '/* HANDOFF */ null'
if ([regex]::Matches($source,[regex]::Escape($marker)).Count -ne 1) { throw '浏览器模板身份不符。' }
$dir = Resolve-Ordinary $ArtifactDirectory
if ($dir -ine (Join-Path $env:USERPROFILE '.dsh/artifacts/playwright')) { throw '目标不是本机 Playwright 交接目录。' }
# Read exactly the fresh handoff in a disposable offline about:blank context. Close it before visiting DSH.
# A code echo contains only paths; the URL is never serialized in an artifact, exception, or MCP argument/result.
$inputExpression = @'
await (async () => {
  let isolated;
  try {
    isolated = await page.context().browser().newContext({ serviceWorkers: 'block', offline: true });
    await isolated.route('**/*', route => route.abort());
    const blank = await isolated.newPage();
    await blank.setContent('<input type="file">');
    const input = blank.locator('input');
    await input.setInputFiles(READY_PATH);
    return await input.evaluate(async el => {
      const v = JSON.parse(await el.files[0].text());
      if (v.status !== 'ready' || v.base !== EXPECTED_BASE || typeof v.launchUrl !== 'string' || !v.launchUrl.startsWith(v.base + '/?')) return null;
      const u = new URL(v.launchUrl);
      return u.origin === v.base && u.pathname === '/' && u.search.length > 1 && !u.hash && !u.username && !u.password ? { base: v.base, url: u.href } : null;
    });
  } catch (_) { return null; }
  finally { if (isolated) await isolated.close().catch(() => {}); }
})()
'@
$inputExpression = $inputExpression.Replace('READY_PATH', (ConvertTo-Json $readyFile -Compress)).Replace('EXPECTED_BASE', (ConvertTo-Json $ready.base -Compress))
$tag = [guid]::NewGuid().ToString('N')
if ($CaptureCards) {
  $capture = '/* VERIFIED_CARD */'
  if ($Kind -cne 'browser' -or [regex]::Matches($source,[regex]::Escape($capture)).Count -ne 1) { throw '未找到唯一的已核实卡片截图位置。' }
  $light = Join-Path $dir "agy-trial-card-$tag-light.png"
  $dark = Join-Path $dir "agy-trial-card-$tag-dark.png"
  if ((Test-Path -LiteralPath $light) -or (Test-Path -LiteralPath $dark)) { throw '截图路径已被占用。' }
  $source = $source.Replace($capture, "await card.screenshot({path: zh ? $(ConvertTo-Json $dark -Compress) : $(ConvertTo-Json $light -Compress), animations: 'disabled', timeout: 10000});")
}
$out = Join-Path $dir ("agy-trial-{0}-{1}.js" -f $Kind, $tag)
$stream = [IO.File]::Open($out,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try {
  $text = $source.Replace($marker, $inputExpression)
  if ($text.Contains($ready.launchUrl)) { throw '浏览器程序含私有地址，已停止。' }
  $data = [Text.UTF8Encoding]::new($false).GetBytes($text)
  $stream.Write($data, 0, $data.Length)
} finally { $stream.Dispose() }
"Playwright MCP: $out"
