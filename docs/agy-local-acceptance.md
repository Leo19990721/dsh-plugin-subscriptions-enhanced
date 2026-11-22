# 本机 agy 验收

环境：Windows x64、DSH Desktop `0.2.2-rc.5`、本机 Authenticode 有效（Google LLC）的 `agy 1.5.12`。真实请求只读写合成数据，用现有官方 CLI 登录；验收 Host 使用已安装 DSH 库和独立存储，不安装到日用 profile。

## 官方 ACP 实测

| 项 | 观察结果 |
| --- | --- |
| cwd / 工具 | 有中文段的实际工作目录可用。官方 `--dangerously-skip-permissions` 用于明确的「完全权限／无需审批」；实测相对路径读、写文件、Windows 终端读文件和公开网页搜索。`--sandbox` 仍可能发 `session/request_permission`，不能拿它当 DSH 的 ACL 沙箱。 |
| 流 | `agent_message_chunk`、`agent_thought_chunk`、`tool_call` 和 `tool_call_update` 都有实际返回；读文件的路径常见于 `locations`，终端结果可出现在 `content` 文本，编辑更新可带 `diff`。DSH 显示工具名、状态、可用的短结果，不重新执行。 |
| 图片/文件 | `promptCapabilities` 为 `image: true, embeddedContext: true, audio: false`。实测 ACP 图片 `{type:"image", mimeType, data}` 可看见。`resource_link` 可识别但不自动读取内容，普通 DSH 上传还附上可读存储路径，由 `agy` 工具读取。超过 64 KiB 的文本实测可用。 |
| 恢复 | 宣告支持 `load/list/resume/close`。关闭 ACP 再起进程，`session/load` 用原 ID 返回历史事件，下一轮记住随机口令。DSH 不重复显示 replay；失效 ID 回退由合成对端验收。 |
| 规则/MCP | 项目根 `AGENTS.md` 和独立 HOME 的 `.gemini/GEMINI.md` 实测生效；`.gemini/antigravity-cli/GEMINI.md` 不按同样方式自动载入。`session/new.mcpServers` 的 stdio 与 Streamable HTTP 实测可用，CLI 独立 HOME 下的 `mcp_config.json` 也可加载。成品走 ACP HTTP，本机已有 MCP 仍由 DSH 执行。 |
| 代理 | 本机无代理环境变量时从 Windows 当前用户的系统配置解析到当前代理；没有固定端口。 |

## 成品链路

[真实验收](../tests/agy-local-signed.test.mjs) 通过已安装 DSH 的原生入队、模型适配器、附件服务、会话存储及流式跟随接口。普通模型先发一轮，再切到 Gemini：用随机标记核对上文、目录内文件和全局规则；真实 `agy` 调用一项合成的 DSH Knowledge 工具；下一轮继续回忆口令，同时读普通上传、识图并写回文件；关闭并重建 Host，原官方 ID 不变，仍答回口令。真实 Windows、Playwright、Knowledge 业务动作没有逐个下发，候选包也没有装到日用桌面验收其视觉界面。

已安装 DSH 的 Electron Node 模式中，先构建 `node scripts/build.mjs`，给子进程设置 `ELECTRON_RUN_AS_NODE=1` 和 `AGY_LOCAL_SMOKE_EXE`（绝对官方 CLI 路径），再执行 `--expose-internals --import ./scripts/runtime-hook.mjs --test --test-isolation=none tests/agy-local-signed.test.mjs`。其余回归默认不访问模型。官方背景资料：[ACP](https://antigravity.google/docs/ide/extensions/acp/)、[终端沙箱](https://antigravity.google/docs/sandbox/)、[MCP](https://antigravity.google/docs/cli/mcp/)。
