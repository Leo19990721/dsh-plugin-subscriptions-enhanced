# Gemini 原生会话验收

这份记录针对 `0.3.0-gemini.2` 的独立会话试验。后续接入改为[在同一个 DSH 会话切换 Antigravity](<antigravity-same-session.md>)，该页记录新方案的隔离实现和验收。

## 本地验证

- DSH Desktop `0.2.2-rc.5`，安装构建 `3f85d888b1297107937d9bd5b853f7e733e179a4`。隔离内存环境使用安装版的 Host Connection、Session、Typert Gateway，搭配合成浏览器身份和 ACP 对端。已覆盖原生发送、增量及重连、Stop 后保留尾片、等待终态、列出历史后重新加载。普通请求仍走原有 Gateway；另一个已认证的 owner Peer 无法替本机浏览器打开、发送或停止 Gemini。测试没有挂载现用浏览器，也没有运行真实模型。入口：[Native Host 回归](../tests/agy-native-agent.test.mjs)、[入口鉴权回归](../tests/agy-host.test.mjs)。
- [真实缓存回归](../tests/agy-native-cache.test.mjs)把安装版的会话、标题和共享缓存挂在隔离 Host 中，实际读取临时目录里的 JSON。合成会话从未取得 JSONL 日志写入句柄；轮次结束或先关闭会话时，完整的第一条正文仍写入 `titleInput.first`，手动改标题也不会去掉它。启用同一个共享缓存后，Gemini 在创建会话或 Agent 之前被拦下；普通会话的缓存照常写入。测试关闭后移除临时文件。
- [普通会话操作回归](<../tests/agy-native-cache.test.mjs#L301-L350>)在隔离 Host 中不挂共享缓存，也不把合成 Gemini 会话加入工作区。它仍出现在普通会话列表，能被置顶和归档；关闭会话后，归档记录仍保存在普通工作区的存储中。
- [附件上传回归](<../tests/agy-native-cache.test.mjs#L352-L405>)走安装版的原生上传路由和本地附件库。登记合成会话前，上传被拒绝，磁盘没有文件。登记后，普通上传接口在点击发送前就会保存文件；随后提交被拒绝，Gemini 没收到消息。关闭会话会清除上传凭证，但保留文件。测试使用自建目录，没有启动 HTTP 监听，也没有访问现用附件库；结束时已清理文件。
- Windows x64 的 `agy 1.5.12` 来自 [Google 发布清单](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json)，Google LLC Authenticode 状态为 `Valid`，已核对发布文件 SHA-512。本次校验使用的 SHA-256 为 `397f0acb4005232799ebea7d5691fd113be009695f1986321876a300bf80aec6`。用隔离目录和项目的 [ACP 传输](../src/agy-acp-client.js) 执行 `agy --mode=default acp --sandbox --disable-telemetry`：只发 `initialize`，返回 ACP v1，报告支持 `load/list/resume/close`，进程已回收。未尝试登录、创建官方会话或调用模型。复现入口：[Windows 握手](../scripts/smoke-agy-windows.mjs)。

## 当前 DSH 缺少的接口

2026-11-20 核对：[GitHub 公开发布](https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=1)、[npm `latest` 和 `next`](https://registry.npmjs.org/-/package/@deepseek-ai%2fdsh/dist-tags)、Windows [稳定版](https://download.deepseek.com/dsh-desk/feeds/win-x64/stable.yml)和[开发版](https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml)都指向 `0.2.2-rc.5`。公开 `master` 提交 `2e39e70496aa02986ca6a820c5d497e816b69d7e` 与本机构建不同。该公开提交的[会话地址](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/api/session-controller/src/client/contract/sessions.ts#L21-L22)仍只接受普通会话和子代理。[原生对话文档](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/client/ui-conversation/README.zh.md#known-limitations-and-deferred-work)明确写了 `conversation.content` 会继承渲染位置的会话，需要另设会话 provider 才能接收独立地址。[DSH 的 ACP 服务](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/acp/acp/README.md#protocol-contract)供外部编辑器调用 DSH；[ACP 子代理](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/subagent/subagent-acp/README.md#start-and-ownership-flow)供普通 DSH 会话委派，不能让用户在原生输入框接着对话。

本机发布版默认[挂载共享会话缓存](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5)。它[给已注册的会话写入投影](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5)，即使该会话没有日志写入句柄。[标题投影](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5)会把首条正文保存在 `titleInput.first`。浏览器端的[会话草稿](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5)按普通会话 ID 保存；[附件](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5)在加入草稿时就可能上传，等到 Host 拒绝发送已经太晚。归档、置顶按照[会话是否已登记](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5)判断；[调度](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5)可接受已登记且非子代理的 Agent。只关闭共享缓存仍然不能隔离这些操作。

建议 DSH 为外部会话增加独立地址和一个可撤销的数据接口，供现有 `conversation.content` 读取。该接口负责取得消息、提交、停止、续聊和审批，并声明允许的操作。外部会话沿用同一个聊天视图和输入框；不要登记为普通 Agent，也不进入普通缓存、调度、导出和远程接口。关闭不适用的附件、队列、模型选择及普通模式操作，草稿默认留在内存。不要在现用 Desktop 停用全局缓存或覆盖原生 Controller。

## 复跑安装版回归

在项目目录内，通过 DSH 提供的运行时启动 [回归入口](../scripts/test.mjs)。`--require-installed` 会在读不到安装版运行时时返回失败，避免只跑普通 Node 测试就算作安装版通过。以下命令不构建、不安装、不变更当前 Desktop 配置：

```powershell
$start = [Diagnostics.ProcessStartInfo]::new($env:DSH_NODE_EXECUTABLE)
$start.WorkingDirectory = (Get-Location).ProviderPath
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.Environment['ELECTRON_RUN_AS_NODE'] = '1'
$start.Environment['RELEASE_TGZ'] = (Get-Item -LiteralPath '.local-install/dsh-subscriptions-enhanced-0.3.0-gemini.2.tgz' -ErrorAction Stop).FullName
$start.ArgumentList.Add('scripts/test.mjs')
$start.ArgumentList.Add('--require-installed')
$process = [Diagnostics.Process]::Start($start)
$process.WaitForExit()
if ($process.ExitCode -ne 0) { throw "安装版测试失败：$($process.ExitCode)" }
```

## 开放真实会话前的检查

1. 先用合成对端。从工作区新建 Gemini，使用现有的输入框发送中文，看到分片，点击 Stop；尾片按顺序显示，收到终态后才允许下一轮。切换回普通会话，再打开 Gemini；历史由 ACP `session/load` 恢复。用同一段带标记的合成输入核对：普通日志、投影、搜索、导出和浏览器持久草稿均找不到 Gemini 正文；归档、置顶和调度拒绝外部会话；拖入或粘贴文件不会触发普通上传，Host 收到指向外部会话的普通上传请求也须在写入字节前拒绝。另一个已认证的客户端也不能代替用户操作这条会话。同一环境中复跑普通会话和 Codex 回归。
2. 用专用目录启动官方 CLI，由用户通过官方流程登录。先验收真实纯文本对话和进程退出，再用临时文件验证默认模式会在写入前请求确认。按 Google 的[执行模式](https://antigravity.google/docs/cli/modes)和[终端沙箱说明](https://antigravity.google/docs/sandbox#antigravity-cli)检查实际权限；Windows 终端沙箱要求 Windows 11 24H2 或更新版本，以及 2026 年 8 月更新或以后补丁。不支持时 `--sandbox` 不生效。实际运行权限待验收。测试只用 CLI 的专用目录，不使用现用 DSH 凭据或工具配置。
3. 用合成文档逐项验收文件、代码、Office 和浏览器工作。分别确认读写范围、修改前审批、Stop 和文件结果；不能用初始化握手代替这些检查。

安装版运行时复跑 **118 项通过，无跳过**，包含真实缓存、普通会话操作、附件写入和试验包内容比对。[本地试验包](../.local-install/dsh-subscriptions-enhanced-0.3.0-gemini.2.tgz)未变，SHA-256 为 `4d06e01427b7bf805695baec066c67f9c9788ff0d1e488ddeb9e5f3501449b38`。

当前 [Host 入口](../src/agy-host.js#L289-L293) 不会启动真实 Gemini。试验包未安装或发布。现用 `0.2.8` 保持启用，更名后的 `0.2.9` 仍保持关闭。
