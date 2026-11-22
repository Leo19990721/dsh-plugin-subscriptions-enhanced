# Antigravity 原生会话验收

「订阅增强」的 Antigravity ACP 在从 DSH rc.5 源码构建的 Web 页面通过合成对端验收。原生模型菜单和 `/model` 改选后，下一条消息走新模型；正在执行的轮次和 Stop 仍归原执行器。原有会话 ID、工作区、草稿、队列、搜索、置顶和归档继续使用。切模型不弹确认，也不另开会话。

本仓库保留源码补丁和可复跑测试。测试使用独立配置和合成数据，不使用 Google 登录状态。日用 Desktop、账号、会话、配置和 `0.3.0-gemini.2` 试验包保持原样。`0.3.0-gemini.3` 候选包也只显示接入状态，不含这套 ACP 执行代码。

## 实际行为

- Antigravity 只出现在获准的本机会话目录。选入和切回都不改部署默认模型，也不会把 Antigravity 提供给子代理和普通模型适配器。写作预设保留，切回普通模型时仍遵守原有预设限制。
- Antigravity 目前只收正文。文件、图片、路径引用和需要展开的引用都会在发送前被拦住，草稿留在原处。单独输入 `/file` 时，输入框提示只收文本，不上传也不发送这条指令。异步准备消息期间若另一个窗口改了模型，Host 会拒绝这次发送，保留草稿。
- 排队项仍按提交顺序处理。队列有内容时，不能改选成会让旧消息换去向的模型。Stop 保留队列。重启后，旧的 Antigravity 排队项仍可见，但没有本次进程的授权；先移除它，再发送草稿。
- DSH 会在官方请求可能写出前保存待确认记录。确定没有写出时撤回记录；写出后断线且无终态时，保留已经收到的文本，标记结果未知，不自动重发、不回退到其他模型。切回 Antigravity 时复用同一个官方会话。原型默认只发送本轮正文，不导入旧 DSH 历史；官方会话已有的上下文仍由 `agy` 管理。只有明确开启 `includeDshHistory: true` 的合成用例才验证最多 32 KiB 的历史交接。
- Antigravity 正文按普通 DSH 历史保存，遵循原有搜索、导出和已授权读取范围。会话一旦记录整轮执行选择，内置后台标题生成和压缩不再发送其历史，DeepSeek 请求也不再附上原始会话日志。切回普通模型后，用户显式发送消息时仍可带上可见历史。合成测试里的 ACP 工具权限请求直接返回取消；真实工具审批界面尚未接通。

## 补丁

| 顺序 | 文件 | SHA-256 |
|---|---|---|
| 1 | [DSH 整轮执行入口](<../patches/dsh-rc5-turn-executor.patch>) | `b1cff3ada2cfe237357ccfd61c884c59b1192a1d43dee73325cfc27c1ef018b8` |
| 2 | [Antigravity 原生会话接入](<../patches/dsh-rc5-antigravity-native.patch>) | `13e88e3a9611983fe0a716985a4ece7955218f376b6facdd5460be0f3b1c2fdd` |

基线是公开 [`dsh-v0.2.2-rc.5`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5)，提交 `9c2670d3bce5275e0d1610272958121af87787bb`。[官方源码归档](https://codeload.github.com/deepseek-ai/deepseek-harness/tar.gz/9c2670d3bce5275e0d1610272958121af87787bb) SHA-256 为 `7f4dea3e905e35473bb0fee6849e6b92a054c375282942666d777f5f4410f987`。归档与 GitHub 文件树只在三个与补丁无关的 Windows `.cmd` 文件的换行上不同；本次往返验证保留归档字节。以归档重建的索引应用第一层后，树为 `c2acd4988acb0b6a7a203b0595909619b13a18d6`；应用第二层后为 `c3619ff7d976fa13161b0bd812e0071cc1202324`。依次回退两层恢复原始归档树，重新应用恢复同一结果。第二层共 118 个文件、481432 字节；补丁展开后的文件逐一与测试源码对照，字节一致。补丁不含构建输出、依赖、账号或会话数据。DSH 源码按 [MIT 许可证](<../LICENSE-DSH>)使用。

[订阅增强的 Host 适配器](<../src/agy-native-turn-host.js>)和 [ACP 执行器](<../src/agy-turn-executor.js>)保留在本仓库；第二层补丁提供原生 Host、客户端和测试挂接点，不修改 [现有打包入口](<../scripts/build.mjs#L25-L27>)。

## 复跑

使用 Windows PowerShell 7、Node.js `24.18.0` 和 DSH 锁定的 pnpm `11.28.5`。在本仓库的 `tmp` 下准备独立的公开标签源码；不要用 Desktop 安装目录。使用 Git 检出时，先核对提交（上表对应公开标签），再在本仓库根目录按序应用两层：

```powershell
$source = (Resolve-Path -LiteralPath 'tmp/dsh-rc5-check').ProviderPath
if ((git -C $source rev-parse HEAD) -cne '9c2670d3bce5275e0d1610272958121af87787bb') {
  throw 'DSH 源码基线不同'
}
foreach ($name in 'dsh-rc5-turn-executor.patch','dsh-rc5-antigravity-native.patch') {
  $patch = (Resolve-Path -LiteralPath "patches/$name").ProviderPath
  git -C $source apply --check --whitespace=error $patch
  if ($LASTEXITCODE) { throw "补丁检查失败：$name" }
  git -C $source apply --whitespace=error $patch
  if ($LASTEXITCODE) { throw "补丁应用失败：$name" }
}
```

已有依赖可以跳过本段。首次准备依赖，请在未载入账号或 API Key 的干净终端运行下列命令，使用专用 pnpm store 和空的 npm 配置。锁文件 SHA-256 为 `c24a38565023f08480f3832a554a676ad7479d36c0868063c85ad66ba6d3e68a`。依赖来自 npm 官方源；SheetJS 另由锁文件指定其官方 CDN 和完整性值。遇到 CDN 下载失败时保留锁文件，使用与锁定完整性相同的归档后再试。

```powershell
$dep = Join-Path $source '.native-test-deps'
New-Item -ItemType Directory -Path $dep -ErrorAction Stop | Out-Null
$env:NPM_CONFIG_USERCONFIG = $env:NPM_CONFIG_GLOBALCONFIG = Join-Path $dep 'empty.npmrc'
New-Item -ItemType File -Path $env:NPM_CONFIG_USERCONFIG -ErrorAction Stop | Out-Null
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
$env:npm_config_store_dir = Join-Path $dep 'store'
pnpm --dir $source install --frozen-lockfile --ignore-scripts --ignore-pnpmfile `
  --store-dir $env:npm_config_store_dir --registry=https://registry.npmjs.org/
if ($LASTEXITCODE) { throw '隔离源码的依赖准备失败' }
```

从本仓库根目录运行以下命令。当前已准备好的本机隔离源码是 `tmp/dsh-rc5-acp-native/source`，使用它时可跳过前两步并直接填入该路径。

```powershell
& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile `
  -File scripts/test-agy-native-source.ps1 -Source $source
```

[复跑脚本](<../scripts/test-agy-native-source.ps1>) 只接受本仓库 `tmp` 下的独立源码；它生成 Typert 接口，临时放入[集成用例](<../tests/fixtures/agy-native-source.fixture.ts>)，使用新建的空测试目录并清掉测试文件。用例经 DSH Loader 加载真实 Host 插件，由真实 Connection 和 Gateway 处理进程内请求，使用真实 JSONL 与搜索库；普通模型和官方 ACP 进程用合成对端。它不监听端口、不启动真实 `agy.exe`、不使用登录状态。

### 构建并验收原生 Web

在同一个干净终端构建。已有应用了上述补丁的完整构建，可以直接启动测试。首次构建使用安装依赖时的同一份专用 store 和 npm 配置。在 Windows 上直接运行 DSH 的构建脚本，避免 pnpm 在运行构建前自动重装依赖。

```powershell
Push-Location -LiteralPath $source
try {
  $env:npm_config_verify_deps_before_run = 'false'
  node --import tsx/esm scripts/build.ts --scope artifacts --serial
  if ($LASTEXITCODE) { throw 'DSH 构建失败' }
  node --import tsx/esm scripts/build.ts --scope check --serial
  if ($LASTEXITCODE) { throw 'DSH 类型检查失败' }
} finally { Pop-Location }
```

1. 从本仓库根目录运行下列命令。`$browserArtifacts` 填当前 Playwright MCP 允许读取脚本的已有目录。保持进程运行，等到输出 `Ready` 和 `Playwright MCP filename`。

   ```powershell
   $browserArtifacts = (Join-Path $HOME '.dsh\artifacts\playwright')
   & 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile `
     -File scripts/start-agy-native-web-fixture.ps1 -Source $source -BrowserArtifacts $browserArtifacts
   ```

2. 将 `Playwright MCP filename` 后的路径传给 `browser_run_code_unsafe` 的 `filename`。交接脚本含本次测试进程的启动凭证，不要打印或分享内容。应返回 `passed: true`，同一个 DSH 会话创建一次；合成 ACP 绑定一次、收到两条提示和一次取消，普通模型收到三条提示。
3. 在启动器输出的 `Isolated Web fixture` 目录内创建空的 `stop` 文件，等 `Isolated DSH Web stopped.`。启动器清理测试数据及交接文件；浏览器脚本退出时关闭独立上下文。

[Web 启动器](<../scripts/start-agy-native-web-fixture.ps1>)使用构建后的 DSH CLI 和真实 Web 页面，由 [Host 测试插件](<../tests/fixtures/agy-native-web.host.mjs>)提供合成模型和观察数据。[浏览器用例](<../tests/fixtures/agy-native-web.browser.js>)操作页面原有控件，只访问测试监听器。测试使用空白配置、独立工作区和真实 DSH 会话存储；不启动 `agy.exe`，也不登录 Google。

## 验证结果

2026-11-20（北京时间），Windows 上的最终版本通过 8 个构建步骤和 Host、Client 两项汇总类型检查。Playwright 打开了这份构建提供的真实页面；构建清单包含 371 个客户端产物（摘要 `00e803b1fdf1dfcc8f78c3e50edd77075a68db0f2de8937d70be7f561adecea9`）。

| 范围 | 实际结果 |
|---|---|
| 原生 Web | 7 项通过：Enter 发消息；用原生菜单选模型和合成推理档位；保留带附件的草稿；`/file` 不发送也不上传；用 `/model` 切回；队列不插话、不改投，切回后 Stop 仍到原轮次；按 ACP 回复正文找到原会话，置顶、归档和归档筛选生效。全程只有一个 DSH 会话，无确认框、页面异常或外部请求。 |
| 最终回归 | 命令服务 72 项、输入栏 148 项通过。最后修改的 7 个 TypeScript 文件通过类型感知 lint；更新的两份双语文档配对检查通过，1,315 个客户端文件通过文案归属检查。 |
| 同会话 ACP 集成 | 4/4：双向切换、真实原生 Session 标识、搜索、置顶与归档、切回后 Stop、部分回复保留、重启后拒绝旧队列、重复回执、附件保存前拒绝、旧订阅方不收到新跟随字段。 |
| 前一轮 DSH 源码回归 | Host 64 个测试文件，1,072 项通过、1 项按上游规则在 Windows 跳过；客户端及 Session 接口 70 个测试文件，1,508 项通过。持久类型检查无变化，相关 lint 和文档检查通过。 |
| 订阅增强可移植回归 | 185 项通过、1 项安装版专属测试跳过。覆盖写前超时不发送、不取消、撤回未发送标记。 |

上表的 Web 合成用例显式启用了历史交接：两次 ACP 发送复用同一绑定，第二次收到中间普通模型的已完成正文。唯一一次 Stop 到达 ACP，部分回复保留，接下来的消息回到普通模型。测试监听器和浏览器交接文件已清理。

2026-11-21，在同一份补丁基线上重新运行 4 项 Host 集成用例，全部通过。默认分支的第二条 ACP 请求只含本轮正文，仍复用首轮的官方会话 ID；没有重跑 Web UI。执行器另有 37 项合成单测，覆盖旧历史过长、绑定终点不匹配和读取期间 Stop。日用 Desktop 监听进程和原试验包 SHA-256 未变化。

前一轮分层检查在干净基线上已有 85 条报告，应用当时的第二层后与基线逐条相同。TypeScript SDK 的 V3 中断队列回放检查通过；两个子进程快照在本机 Windows 中文路径的规范化或 JSON 解析阶段未通过，快照内容未改。macOS/Linux 上的完整回放以及 Python SDK 的发布形态快照尚未验收。

## 日用 Desktop 启用条件

2026-11-21（北京时间），读取日用 Desktop `0.2.2-rc.5` 安装内的两个 Host 类。`AgentLoop` 缺少 `registerTurnExecutor`，`SessionController` 缺少 `registerTurnProvider`。[启动预检](<../src/agy-native-turn-host.js#L55-L78>)会先检查这两个方法；缺任意一个，就在启动 agy、提供 Google 登录或打开绑定记录前停止。日用插件和应用均未变更。

Desktop 将原生界面、Host 和 CLI 一起打包发布。通过方法检查后，还要核对同一构建的客户端按会话取模型，发送时带上选定模型，排队项保持原去向，Stop 仍归实际执行的一轮。Desktop 的 `dsh-app://app` 转发也要通过本机用户身份验证。不要给旧 Host 单独换客户端、覆盖签名安装包，或把 Antigravity 放进普通模型适配器。

[官方 CLI 握手脚本](<../scripts/smoke-agy-windows.mjs>)可显式接收 `--loopback-proxy http://127.0.0.1:端口`，仅把无认证的本机 HTTP 代理传给 agy 子进程。缺省不继承代理。脚本只发 `initialize`，用不到 Google 登录或会话。CLI 是否在真实登录和推理时使用这些变量尚未验证。

Desktop 具备上述能力后，先验证 Windows 沙箱、原生工具审批及安全回退，再用官方登录和一条原生正文核对 agy 子进程及同一会话的回复。切模型不需要确认，工具调用的授权单独处理。发布前还要测长 JSONL 会话的读盘开销，以及导出和远程可见范围。

### 回退前检查队列

[安装版回归](<../tests/agy-native-turn.test.mjs#L221-L258>)用 `0.2.2-rc.5` 原版 Host 读取独立的合成 V4 会话：Antigravity 排队项恢复后仍在列表里；切到普通模型再发送时，旧版把这条排队正文交给了普通模型适配器。没有调用远程模型。相关安装版回归 18 项通过。

不能只靠保存一份安装包来回退。回退前得停止接收新消息，等官方轮次结束或确认 Stop，逐会话核对运行状态、剩余队列和未确认的发送。若仍有 Antigravity 排队项，须先在兼容版本中保全内容并从执行队列移除；未确认的发送保留状态，禁止自动重发。回退流程还需验证在无法确认这些条件时会停止。
