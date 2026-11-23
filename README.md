# Subscriptions Enhanced

基于 [V1ki/dsh-plugin-subscriptions 0.9.13](https://github.com/V1ki/dsh-plugin-subscriptions) 的 MIT 增强版。

## 在 DSH 用本机 Gemini 干活

自 `0.3.5` 起，DSH 接口包的 peer 依赖不设版本区间，本机 `agy.exe` 也不再限定版本或文件摘要。请使用从 Google 安装的 Windows x64 CLI；运行时仍检查本机路径和 ACP 协议。在原来的聊天模型菜单或 `/model` 里选 **Google Antigravity → Gemini**，不用换预设或另开会话。仍只走[官方 `agy acp`](https://antigravity.google/docs/ide/extensions/acp/)，没有旧私有直连备用通道。

- **工作目录和工具**：使用当前会话的实际工作目录，包含 DSH 已提交的目录变更。DSH「完全权限／无需审批」时，`agy` 按本机权限读写文件、跑命令、联网；完全权限但要求审批时，ACP 的确认请求交给 DSH。「工作区内」仅允许修改工作区文件，「只读」拒绝编辑；两种模式都支持网页读取及 DSH MCP，但仍禁用 Gemini 原生终端和网页交互。已处于权限范围内的 ACP 操作按 DSH 审批设置确认或直接放行；经 MCP 调用的工具沿用各自的原生权限和审批。原生「插话」中止当前 ACP 回合并接着发送；「排队」等当前回复结束。
- **进度和附件**：支持的 DSH 聊天界面会在当轮「过程」中实时显示 Gemini 的工具卡片：操作类别、目标、状态和耗时，展开可看短输出与文件改动摘要。可在会话历史中回看；不支持工具卡片时仍在「思考」里显示进度。卡片只记录展示信息，DSH 不会重跑 `agy` 的工具。拖入图片会发送图像；普通附件按 DSH 的实际存储路径交给 `agy` 按需读取，粘贴文件路径也可以。去掉旧版 64 KiB 文本门槛，仍受 DSH 附件限制、ACP 单帧 16 MiB 上限及模型上下文限制。
- **续聊**：官方会话状态和对应关系保存在当前 DSH profile 的 `plugin-data/subscriptions-enhanced/agy` 下（无 profile 时在 DSH home）。重启优先恢复同一个官方会话。如果无法恢复该会话、工作目录变更、历史回滚或执行 `/compact`，就带上最近的对话或压缩摘要，新开官方会话。订阅代理切换会在下一条消息生效。第一次从其他模型切入 Gemini，或切走聊一段再回来，也会带上更新的正文；不搬历史图片、工具输出、思考或其他模型的系统提示词。
- **规则、技能和预设**：全局与工作区根目录的 `AGENTS.md` 写入隔离的 `~/.gemini/GEMINI.md`，并加入当前自定义预设声明的 persona。全局与工作区 `.dsh/skills` 合并复制，不建链接，工作区同名优先。规则和技能的更新、删除在下一条消息前生效。
- **MCP 和原生工具**：默认桥接当前 DSH 会话允许执行的 `mcp__*`、`remote_*`，以及待办、问答、交付物、Office 渲染/转换/重算、会话检索/追踪和定时任务管理工具。桥接只在本机运行，不复制凭据；宿主未安装、预设禁用或未激活的工具不会暴露。有原生问答工具时，Gemini 会使用 DSH 中可见的问答面板，不在隐藏的终端提问。启用原生子代理的预设还会提供 `subagent`、`send_message`、`list_agents` 和 `wait_agent`。子代理显示在 DSH 原生会话面板，结果由 DSH 投递；仅本机用户发起的聊天树可以运行 Gemini 子代理。跨模型需在 **设置 → 内置插件 → 子代理** 允许目标模型，并使用采样了新设置的新会话。

插件默认从 `%LOCALAPPDATA%\agy\bin\agy.exe` 找 CLI；用[官方 CLI](https://antigravity.google/docs/getting-started?tab=cli)登录，不需要 Google API Key。登录之后回到 **设置 → 模型 → Google Antigravity 接入状态**，点「重新检查」。Gemini 新消息从本机 DSH 聊天框提交，不开放远程或无人值守调用。

已连接并选用 Google Antigravity 时，点击**聊天输入框下方的订阅用量胶囊**，即可查看各模型组的剩余百分比、本地重置时间和 G1 Credits 余额。首次打开才查询，再打开直接显示缓存，需更新时点「刷新」。**设置 → 模型 → Google Antigravity → 管理**也会显示同一份结果。查询只在用户操作时通过官方 `agy --print` 执行，不弹终端、不后台轮询。

可以在插件的 `google` 配置里覆盖 `executable`、`dataDir` 和 `agentsFile`（为空则不加载全局规则）。`proxy` 默认 `auto`：先用已启用的订阅代理，再看代理环境变量，最后走 Windows 当前用户的系统代理；可填明确的代理地址，填 `direct` 或空字符串则直连。订阅代理支持 SOCKS5 和 SOCKS5h。省略 `mcp` 时自动发现；可填写服务器名限定范围（`remote` 也包含原生 Remote 工具），`[]` 不转接这些工具。原生子代理工具是否可用由当前 DSH 预设决定，不受此 MCP 服务器名单影响。

用 DSH 插件管理器添加本机 `.tgz`。同名包可以直接更新；如果还装着旧包名 `dsh-plugin-subscriptions-enhanced`，先把新包安装为未启用，卸载旧名的第三方「订阅增强」，再启用新包。旧名和新名不能同时启用。

## 订阅账号

打开 **设置 → 模型**，在「添加模型提供商」下方找到「订阅账号」。已连接的服务直接显示，点「管理」可以看账号和额度。要连接新服务，打开「添加订阅账号」，选择 Codex、Claude、Grok 或 GitHub Copilot，再点「登录」。最后一个账号退出后，服务回到「添加订阅账号」。代理和额度显示保留在「订阅选项」里。

增强包沿用这些订阅的账号存储、模型 ID、额度查询和请求实现。同一个 DSH 主目录下的账号无需迁移，不需要单独安装 Codex CLI 或填写 API Key。模型、思考强度、普通会话和子代理保持 DSH 原生路径。既有账户池保留原归属；升级只移除退役服务的成员，旧 Antigravity 所属的池停用。额度面板沿用当前 DSH 的定位和点外关闭行为。

## 安装已发布版本

本节用于已发布的稳定版本。`0.3.5` 不声明 `engines.dsh`，也不限制 DSH 接口包的 peer 版本。`0.2.9` 起包名为 `dsh-subscriptions-enhanced`。从本仓库 [Releases](https://github.com/Leo19990721/dsh-plugin-subscriptions-enhanced/releases) 下载正式 `.tgz`，在 DSH 原生插件管理器填写安装包绝对路径或下载 URL。

从旧名 `dsh-plugin-subscriptions-enhanced` 换装时，先保留旧安装包。装好新版后，关闭安装完成页，先别点「立即启用」。等正在使用订阅模型的任务结束，在「插件」页卸载旧名的**订阅增强**，再启用新包。到「设置 → 模型」核对原有账号。启用失败可关闭新包后重新安装旧包。旧名和新名是两个第三方插件包，不要同时启用。

同名新版本可直接通过插件管理器更新。若提示重启，先结束正在执行的任务。对于先加载的第三方上游 `dsh-plugin-subscriptions`，增强包按原插件名称临时覆盖 `llm-subscriptions` 行；停用或卸载增强包会撤掉这层覆盖。DSH 自带的选模、输入框、队列和停止组件不受影响。

## 写作模式

普通模式可自由选择 Gemini 或 GPT，换模型不会自动切换预设。写作模式是基于 DSH 极简配置的快捷预设，只使用 Gemini。

- 空白会话切到写作模式时，优先使用可用的本机 Google Antigravity 模型；没有时回退到其他已配置的 Gemini。当前会话已明确选择的可用 Gemini 会保留。
- 使用官方 `agy` 写作时，会在本机规则后附上中文写作助手人设。退出写作模式后，新开的官方会话不会继承这个人设；DSH 保留原有记录。开始对话后的预设切换仍遵守 DSH 原生规则。
- 自动配对只影响当前空白会话，不写全局默认。

## 开发

Node.js 24、pnpm。执行 `pnpm install --ignore-scripts`、`pnpm build`、`pnpm test`。构建检查上游 Host/Client 的实际补丁接点，并记录输入版本和 SHA-256。Desktop 集成测试使用已安装的 Electron Node 模式读取 ASAR；合成测试不需要真实账号或模型连接。

Windows 执行 `pwsh -NoProfile -File scripts/pack.ps1` 自动构建、测试和打包。`-NodePath`、`-PnpmPath` 可指定已安装的运行时。产物在 `.local-install`。安装包不包含 CLI 可执行文件、密钥、登录缓存或聊天记录。原作者版权及修改见 [LICENSE](./LICENSE) 和 [NOTICE](./NOTICE)。
