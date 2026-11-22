# 订阅版 Antigravity CLI

## 接入方法

[`createAgySubscriptionCli({ root, executable, loopbackProxy })`](../src/agy-subscription-cli.js) 供 Host 调用。导入和构造不碰磁盘、不启动程序，也不安装 CLI、联网检查或登录。Host 完成版本和本机操作人检查后，可显式调用 `probe(signal)`。这一步会启动已安装的官方 CLI，经 ACP v1 创建一个空会话，读取模型和思考档位，关闭会话（CLI 支持时）并清理进程后才返回。探测可能由 CLI 联系 Google 以确认已有登录或取模型列表；没有提示词、模型推理请求或登录调用。没有缓存认证时，官方 ACP 返回 `-32000`。

- `root` 是专用的产品数据目录，须为规范化的本机绝对路径，父目录已存在并且由产品/本机用户信任；请选在 DSH 工作区、账号、会话和配置目录之外，别放在 Git 工作树中。首次显式调用可创建这个目录或接管专门留出的空目录，通过排他写入创建归属标识；不会接管有其他资料的未标记目录。用 `blockedPaths` 将运行目录和可执行文件目录排除在 Host 允许的工作区之外。
- `executable` 指定已经从 Google 取得的 Windows x64 `agy.exe` 的绝对路径，须在 `root` 外。每次启动使用[固定字节数和 SHA-256](../src/agy-launch.js#L6-L47) 校验已核对过 Google LLC 签名的 1.5.12，再核对 ACP 的程序名、协议版本和 `agentInfo.version`。这里使用已签名文件的固定摘要来识别完整文件，不在运行中重新联网查证书或更新 CLI。
- `loopbackProxy` 可省略；设置时只接受无用户名、密码、路径的 `http://127.0.0.1:端口`。它传到 CLI 子进程的代理环境变量；生效范围需实机确认。没有继承系统其它代理或 Google、DSH、Node、Electron 的账号、密钥和配置变量。
- `makeSession({ signal })` 返回还未启动的单轮会话。它只接受 `open()` 新建会话；不接收工作区路径，不支持 `open(id)` 恢复历史。之后使用 `prepare(selection, signal)` 和 `runTurn(text, options)`，总共最多写出一次提示词。Host 在 `finally` 调用会话的 `close()`，卸载时调用工厂的 `dispose()`。模块同时只允许一个会话或探测，跨实例由专用目录的 `active` 标记排他。

CLI 的登录凭据由 CLI 和操作系统管理。根据 [Google 认证说明](https://antigravity.google/docs/install/#local-silent-keyring-sign-in)，Windows Credential Manager 中的 Antigravity 登录可供同一用户的其它官方产品使用；独立 HOME 无法隔离它。模块没有登录或登出方法，不查找、复制或读取认证文件，不接收 Token。如需登录，独立的官方流程要先由操作人明确授权。临时 HOME 能否复用官方 Windows 登录仍待授权实测；`probe` 返回认证失败时不会读取现有 HOME 或替用户启动浏览器。

## 启动检查

每次启动创建全新的 `home`、`local`、`roaming`、`scratch` 和空 `work`；子进程的 cwd 和 ACP `session/new.cwd` 都指向同一个 `work`，与 DSH 的路径无关。环境只通过 [`agyWindowsEnv`](../src/agy-launch.js#L54-L79) 生成。官方 [CLI 设置](https://antigravity.google/docs/settings?tab=cli) 说明设置位于 `~/.gemini/antigravity-cli/settings.json`。绝对路径由本次专用 HOME 计算。启动时写入并回读以下固定策略；在收到 `initialize` 和 `session/new` 回复后、写提示前，复核关键目录和策略。如果官方 CLI 按文档省略默认 `false` 或空白项，仍核对严格模式、沙箱标记和完整拒绝规则。

```json
{
  "agentMode": "",
  "toolPermission": "strict",
  "allowNonWorkspaceAccess": false,
  "enableTerminalSandbox": true,
  "useG1Credits": false,
  "permissions": {
    "allow": [],
    "ask": [],
    "deny": ["read_file(*)", "write_file(*)", "command(*)", "read_url(*)", "execute_url(*)", "mcp(*)"]
  }
}
```

[Google CLI 权限文档](https://antigravity.google/docs/permissions?tab=cli) 确认这些通配符覆盖各自操作并且拒绝优先；`strict` 令另外需要审批的工具停止等待。本模块没有审批界面，所有 ACP 权限请求直接取消。ACP 初始化不提供文件或终端能力，`session/new` 传空 `mcpServers`。固定启动参数是 `--mode=default acp --sandbox --disable-telemetry`；[官方关闭自动更新变量](https://antigravity.google/docs/cli/troubleshooting/#resolve-self-updater-locks-and-failures) 仅设在子进程。新建的目录不导入任何 [Hook](https://antigravity.google/docs/hooks/) 或 [MCP](https://antigravity.google/docs/cli/mcp/) 配置；对 Google [文档列出的发现目录](https://antigravity.google/docs/customization-discovery/) 进行检查，目录里发现本地定制或处在 Git 仓库就停止。

## 清理和发布条件

[`AgyAcpClient.close()`](../src/agy-acp-client.js#L618-L661) 限时收尾并确认直接子进程退出。目录身份核验后只移除当前进程创建的运行区。无法确认停机或移除时返回 `cleanup-unconfirmed`，保留专用目录的 `active`，新实例也不能另起 CLI；上次异常留下的标记不自动删除。人工恢复前要独立核对残留进程和目录归属，不读取账号文件或对话内容。

这些检查验证的是 DSH 发出的请求和准备的环境。Google 的 [`--sandbox`](https://antigravity.google/docs/sandbox/#antigravity-cli) 是针对终端命令的配置，在部分 Windows 版本上不生效。该桥接没有 Windows Job Object、独立 OS 账号、网络隔离或整个进程树的回收确认，也未通过真实 CLI 验证生效权限、全部本地定制来源、Windows 凭据复用及后台进程退出。真实使用须由发布方先验收这些边界。相应 Windows 验收需要另行授权，不能从一次握手成功推断。

当前回归只用[模拟进程](../tests/agy-subscription-cli.test.mjs)，不运行真实 agy、不登录、不读账号或历史、不发真实提示词。运行 `node --test tests/agy-subscription-cli.test.mjs` 可复跑。
