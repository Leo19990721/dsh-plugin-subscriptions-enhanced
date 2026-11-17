# Subscriptions Enhanced

基于 [V1ki/dsh-plugin-subscriptions 0.9.13](https://github.com/V1ki/dsh-plugin-subscriptions) 的 MIT 增强版，保留原账户、模型设置、额度和网络实现，调整 Antigravity 冷却和短重试，并修复 DSH 额度面板兼容问题。

## 安装

已验证：**DSH 0.2.2-rc.3**。从本仓库 [Releases](https://github.com/Leo19990721/dsh-plugin-subscriptions-enhanced/releases) 下载 `.tgz`，在 DSH 插件管理器填写安装包绝对路径；也可以填写对应版本的下载 URL。

包名为 `dsh-plugin-subscriptions-enhanced`。启用增强会禁用原 `llm-subscriptions` 行，避免重复注册；不要另行启用另一套订阅实现。首次使用在订阅设置中自行登录。升级继续使用原订阅插件的账号存储，不迁移或分发账号数据。

同名新版本通过插件管理器覆盖安装；返回“需要重启”时，结束正在执行的任务后重启 DSH。停用增强并启用原版可回退；升级前保留上一版本安装包。

## 增强内容

- 临时网络、服务器、超时和空响应最多重试两次；保留上游明确要求的等待时间。
- Antigravity 429 不再推测五分钟冷却，明确等待时间仍限定到对应账号和模型。
- Gemini 发送请求时只移除固定的 Harness 身份开场句，并将创造模式的一句应用身份改为中性表述；用户正文、工具声明和其余规则保留。
- 标准、PTC、极简、创造模式由用户选择，不自动切极简。
- 额度小面板适配当前 DSH 的定位和点外关闭行为；其他订阅实现保持上游逻辑。

安装包不包含账号、密钥、登录缓存、聊天记录或作者电脑路径。模型服务可用性、额度和账号规则由服务商决定。

## 开发

Node.js 24、pnpm。执行 `pnpm install --ignore-scripts`、`pnpm build`、`pnpm test`。构建固定上游版本并核对 Host/Client SHA-256；更新上游必须重新审查补丁，不能直接放宽版本。

在运行中的 DSH 会话环境测试，会额外使用实际安装的服务和预设；Desktop 使用 Electron Node 模式访问 ASAR。可选历史提示词样本通过 `DSH_TEST_STANDARD_PROMPT` 指定，不随仓库公开。

Windows 执行 `pwsh -NoProfile -File scripts/pack.ps1` 可自动构建、测试、检查并打包；`-NodePath`、`-PnpmPath` 可指定已有运行环境。产物位于 `.local-install`，包括版本包和 SHA-256。GitHub 标签用于发布经过验证的版本，不推送账号配置。

原作者版权和本地修改说明见 [LICENSE](./LICENSE)、[NOTICE](./NOTICE)。本项目独立维护。
