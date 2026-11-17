# Subscriptions Enhanced

基于 [V1ki/dsh-plugin-subscriptions 0.9.13](https://github.com/V1ki/dsh-plugin-subscriptions) 的 MIT 增强版，保留原账户、模型设置、额度和网络实现。

## 安装

支持 **DSH 0.2.2-rc.3**。安装包名保持 `dsh-plugin-subscriptions-enhanced`，没有另外的专用版。

从本仓库 [Releases](https://github.com/Leo19990721/dsh-plugin-subscriptions-enhanced/releases) 下载经过发布的 `.tgz`，在 DSH 原生插件管理器填写安装包绝对路径或下载 URL。升级继续使用本机原有订阅登录，不迁移或分发账户数据。启用增强只停用原 `llm-subscriptions` 订阅实现；新建会话和已有会话均使用原生界面，模式、模型、思考强度选择框保持原样。

同名新版本通过插件管理器安装；如果返回“需要重启”，结束正在执行的任务后再由用户重启 DSH。不要同时启用另一套订阅 provider。升级前保留上一版安装包。

## 写作模式

- 在原生新建会话界面选择「写作模式」，后台自动配对可用的 Gemini；还没发第一条消息时选择 Gemini，也自动切到「写作模式」，保留所选的具体模型。
- 空白会话从写作模式选择 GPT 等非 Gemini 模型时，自动回到默认的非写作模式，保留点选的具体模型和思考强度；如果默认模式本身是写作模式，则回到可用的标准模式。
- 会话开始后模式固定，写作模式只接受 Gemini；其他模式只接受非 Gemini。不匹配的选择通过原生错误提示拒绝，当前模型和默认设置不变。
- 写作模式复用本版 DSH 极简模式的图像读取、终端和自动历史压缩能力，只把开头身份替换为用户确认的这句：你是一名中文写作助手，帮助用户起草、修改和整理文字材料。
- 标准、PTC、极简、创造模式在使用 Codex 等其他模型时继续可选。
- 已经开始的对话不更换模式，沿用 DSH 原生规则；增强不增加底栏控件、命令或新会话弹窗。
- 模型按钮和 `/model` 均使用 DSH 原生处理路径。有效选择保留原生默认保存行为；被拒绝的选择不保存默认。后台自动配对不写默认。
- Gemini 按 `gemini-`、`antigravity-gemini-` 及独立账号模型 ID 识别，符合命名的新型号自动适用。

原生菜单仍展示 DSH 完整模型目录，不按会话重绘菜单；后台在保存选择前执行类别校验。该校验使用固定 DSH 0.2.2-rc.3 的 Cordis/Session 写入前事件分发契约，升级 DSH 必须重新验证。原生设置页保持不变。关闭插件不会重写已有会话；曾使用写作模式的会话需要该预设仍然安装。

## 其他增强

- 临时网络、服务器、超时和空响应最多重试两次；保留上游明确要求的等待时间。
- Antigravity 429 不推测五分钟冷却；明确等待时间仍限定到对应账号和模型。
- Gemini 请求只移除固定的 Harness 身份开场句，并将创造模式的一句应用身份改为中性表述；用户正文保留。
- 额度面板兼容当前 DSH 的定位和点外关闭行为。其他订阅逻辑保持固定上游实现。

安装包不包含账户、密钥、登录缓存或聊天记录。HTTP 429、账号限制和模型额度仍按服务商返回值处理。

## 开发

Node.js 24、pnpm。执行 `pnpm install --ignore-scripts`、`pnpm build`、`pnpm test`。构建固定上游版本并核对 Host/Client SHA-256；更新上游必须重新核对补丁和极简模式配置。

在 DSH 环境测试会使用已安装的官方服务和预设，测试中的会话和模型均为合成数据，不读当前登录凭据，不请求真实模型。Desktop 使用 Electron Node 模式读取 ASAR。`DSH_TEST_STANDARD_PROMPT` 是可选私有样本，不随仓库分发。

Windows 执行 `pwsh -NoProfile -File scripts/pack.ps1` 自动构建、测试、检查并打包；`-NodePath`、`-PnpmPath` 可指定已有受管运行时。产物位于 `.local-install`，包括版本包和 SHA-256。GitHub 发布沿用常规标签和 Release，不建设同步服务。

原作者版权和修改说明见 [LICENSE](./LICENSE)、[NOTICE](./NOTICE)。
