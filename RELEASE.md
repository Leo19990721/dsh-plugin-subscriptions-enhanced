# Subscriptions Enhanced

## 0.3.1

- Google Antigravity 额度面板按模型组展示，Gemini 通用额度置顶；周期名随界面语言显示，重置时间按本地时区显示。
- 剩余额度用 DSH 主题的绿、橙、红提示；更新时间与 G1 积分放在底部。刷新时保留上次结果，仍只按点击查询。

## 0.3.0

- 在 Google Antigravity 管理卡片内按需查询剩余额度、重置时间和 G1 Credits，无需打开外部终端。
- 新建并行会话优先归入 GPT 工作区，组内标题不重复标注模型。
- 不再声明 `engines.dsh`；保留 DSH 接口包的 peer 依赖。


- Gemini 模型菜单显示官方思考强度，旧会话若保留了不支持的档位，按当前模型自动降级。
- 选用本机 Google Antigravity 时，模型菜单隐藏不适用的「启用智能体团队协作」；切回其他模型即恢复。
- 普通模式可自由选择 Gemini 或 GPT。写作模式优先选本机 Gemini，并把中文写作人设传给官方 `agy`。
- 新建并行会话使用 `任务名（GPT）` 格式；其他模型显示对应标签，已有会话不改名。

## 0.3.0-gemini.8

- 本机 `agy acp` 握手的客户端标识为 `vscode`（显示名 `VS Code`）。实际仍由 DSH 连接官方 CLI。
- 「设置 → 模型 → Google Antigravity → 管理」增加「查看额度」。按钮只打开本机官方 CLI，手动输入 `/credits` 或 `/config` 查看实时数据；DSH 不取额度或凭据。

## 0.3.0-gemini.5

同会话的 Gemini 从纯文本升级为日用工具会话：实际工作目录和权限、原生思考与进度流、图片/普通附件、长文本、会话恢复、跨模型正文承接和 Windows 自动代理。安装与配置见 [README](./README.md#在-dsh-用本机-gemini-干活)，协议核验和可复现验收见 [本机 agy 验收](./docs/agy-local-acceptance.md)。

## 0.3.0-gemini.3

本地候选包，只在独立测试配置验收，日用配置保持原样。DSH `0.2.2-rc.5` 保留原生选模、发消息、队列和停止组件，无需关闭内置插件。设置页显示官方 Antigravity 的兼容状态；模型菜单不提供 `agy`，包内也没有登录和推理入口。Codex、Claude、Grok 和 GitHub Copilot 的接入保留。旧 Antigravity 登录数据不会清除或转给官方 CLI，会话历史不改写。

旧名 `dsh-plugin-subscriptions-enhanced` 与新名不能同时启用。更名的正式版本按[换装说明](./README.md#安装已发布版本)处理。曾使用同会话 ACP 源码原型的会话，降级前先按[队列检查](./docs/dsh-antigravity-native-source.md#回退前检查队列)处理待发送消息。

### 本地验收

2026-11-21，Windows Desktop `0.2.2-rc.5`（构建 `3f85d888b1297107937d9bd5b853f7e733e179a4`）的 Node 模式通过 306 项回归，含候选归档清单、原生输入和旧队列改投复现；0 失败、0 跳过。[安装器回归](./tests/agy-bundle-lifecycle.test.mjs) 2 项通过，分别验证原生组件替换可撤销、启动失败不会自动恢复。用[实际候选归档](./.local-install/dsh-subscriptions-enhanced-0.3.0-gemini.3.tgz)离线跑过[安装、停用、再启用、卸载和旧名换装](./tests/agy-release-install.test.mjs)，原生选模组件未重启，原有第三方订阅配置恢复，合成账号和用户配置字节不变。合成 Codex 回复和账号状态经过安装版服务；其他订阅未用真实账号联网验收。

[补丁源码](./docs/dsh-antigravity-native-source.md)另有 4 项原生会话测试通过，默认只将本轮正文传给 ACP 合成对端。日用 Desktop 未安装候选、未改配置、未重启；没有向 Google 发送真实消息，也没有公开发布。上面的验证未打开候选的桌面界面，实际布局和主题显示仍未验收。

## 0.3.0-gemini.2

本地试验包。移除旧 Antigravity 直连，新增官方 ACP 的接入状态。Windows `agy 1.5.12` 已通过初始化，隔离 Host 已用合成数据验证原生会话。当前 DSH 无法按会话隔离普通缓存和相关操作，真实 Gemini 会话仍关闭。现用配置不应切换到此包。保留旧账号、会话记录及 Codex 的接入方式。

## 0.2.9 更名

包名更改为 `dsh-subscriptions-enhanced`。保留已有登录、模型 ID、写作模式和当前订阅接入。已经安装旧包的用户请按[换装说明](./README.md#安装已发布版本)操作。

## 0.2.8 的订阅界面更新

- 「设置 → 模型」的订阅区统一按账号状态分组。已连接的服务直接显示，未登录的收进「添加订阅账号」。登录成功后移到外层，退出最后一个账号后移回添加列表。
- 登录途中离开设置，再打开时仍能找到待授权的服务。状态读取失败会提示重试，并保留上次确认的分组。
- 沿用已有登录、原生模型选择和写作模式。DSH 最低仍为 `0.2.2-rc.3`，没有版本上限。
