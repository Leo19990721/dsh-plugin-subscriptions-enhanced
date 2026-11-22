# DSH 原生整轮执行入口

[下载源码补丁](<../patches/dsh-rc5-turn-executor.patch>)。它给 DSH Host 增加 `ctx.agentLoop.registerTurnExecutor()`，供「订阅增强」接入官方 Antigravity ACP。合成测试已经跑通同一个原生 Session 的选路、输入、队列、流式回复和 Stop。现用 Desktop、会话、账号、配置和原试验包未改动。

## 本轮实现

- 普通模型仍走原生模型和工具循环。`turn:` 路由在一轮开始时确定，本轮不会因菜单改选而换执行器。没有另建用户可见会话，也没有新增切换确认。队列中还有待发消息时，拒绝会改变排队项去向的切换，原消息留在原位。
- 外部执行器只接收经过本次注册授权的文本。入队、编辑、领取分开检查。循环用自己持有的会话写句柄，确认原消息和出队记录已落盘后才调用执行器。每次发给外部程序前，执行器还须重验自己的权限，并立即调用 `assertDispatchable()`；归档、Stop 或卸载生效后，这项检查会拒绝新的派发。
- 回复进入原生流和同一份会话日志。本地停止等待后，如果外端结果未知，已收到的文本保留，记录 `TURN_OUTCOME_UNKNOWN`，不自动重发或改走普通模型。只有执行器明确报告终态且原生结束事件落盘，才会调用 `afterCommit` 通知执行器更新记录。
- 从磁盘重开会话后，旧排队项保持可见。预先存在的排队项没有本次进程的授权，不会因挂载同名执行器而自动执行。测试还走了原生 `updateQueue`：外部轮次拒绝中途引导时队列不变，普通轮次仍能在下一步接收原消息。

## 基线

| 对象 | 核对值 |
|---|---|
| 上游标签 | [`dsh-v0.2.2-rc.5`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5) |
| 提交 | `9c2670d3bce5275e0d1610272958121af87787bb` |
| [源码归档](https://codeload.github.com/deepseek-ai/deepseek-harness/tar.gz/9c2670d3bce5275e0d1610272958121af87787bb) SHA-256 | `7f4dea3e905e35473bb0fee6849e6b92a054c375282942666d777f5f4410f987` |
| 补丁 SHA-256 | `b1cff3ada2cfe237357ccfd61c884c59b1192a1d43dee73325cfc27c1ef018b8` |
| 本次工具链 | Windows、Node.js `24.18.0`、pnpm `11.28.5`（源码 `packageManager` 固定版本） |

补丁按公开标签制作，共 17 个文件。实验使用官方源代码归档；本机同版本号的 Desktop 是另一构建。补丁中的 DSH 源码遵循 [DeepSeek MIT 许可证](<../LICENSE-DSH>)。

## 复跑

1. 用公开标签创建一份独立的干净源码树，核对 `git rev-parse HEAD` 等于表中提交；也可核对源码归档的 SHA-256，再解包到其他 Git 仓库以外的独立目录。Windows 解包试验跳过了归档中的 13 个符号链接，未改变补丁涉及的文件。补丁应用到这份源码树，勿应用到 Desktop 安装目录或本项目源码。
2. 在那份源码的根目录执行下面的 PowerShell 命令。`$patch` 填上面补丁的绝对路径。使用干净的终端环境，不载入账号、API Key 或活动 DSH Profile。依赖安装只从 npm 官方源取锁定包，不执行安装脚本；已有依赖时可以跳过安装。

```powershell
$patch = '<补丁的绝对路径>'
git apply --check --whitespace=error $patch
if ($LASTEXITCODE -ne 0) { throw '源码不匹配或补丁检查失败' }
git apply --whitespace=error $patch
if ($LASTEXITCODE -ne 0) { throw '补丁应用失败' }

$scratch = Join-Path (Get-Location).Path '.turn-executor-check'
New-Item -ItemType Directory -Path $scratch -ErrorAction Stop | Out-Null
$env:DSH_HOME = Join-Path $scratch 'dsh-home'
$env:DSH_AGENTS_HOME = Join-Path $scratch 'agents-home'
$env:TMP = $scratch
$env:TEMP = $scratch
$env:DSH_SNAPSHOT = 'replay'
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
$env:NPM_CONFIG_USERCONFIG = Join-Path $scratch 'empty.npmrc'
New-Item -ItemType File -Path $env:NPM_CONFIG_USERCONFIG -ErrorAction Stop | Out-Null
$store = Join-Path $scratch 'pnpm-store'
pnpm --filter '@deepseek-ai/dsh-root' --filter '@deepseek-ai/dsh-agent-loop...' `
  --filter '@deepseek-ai/dsh-api-session-controller...' install --ignore-scripts --ignore-pnpmfile `
  --frozen-lockfile --registry=https://registry.npmjs.org/ --store-dir "$store"
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' }

node node_modules/vitest/vitest.mjs run --maxWorkers=3 `
  packages/core/agent-loop/tests packages/core/agent/tests `
  packages/api/session-controller/tests/archived-session-gate.host.spec.ts `
  packages/api/session-controller/tests/empty-prompt.host.spec.ts `
  packages/api/session-controller/tests/commands-queue-attachment.host.spec.ts `
  packages/api/session-controller/tests/turn-executor-queue.host.spec.ts
if ($LASTEXITCODE -ne 0) { throw '回归测试失败' }

node node_modules/typescript/lib/tsc.js --build `
  packages/core/agent-loop/tsconfig.json packages/api/session-controller/tsconfig.host.json
if ($LASTEXITCODE -ne 0) { throw 'Host 编译失败' }
```

## 验证结果

- 独立源码回归 **635 项通过，1 项按上游规则在 Windows 跳过**。新增执行器和队列专项共 14 项。独立审查发现的两项问题已修复并复核：外部轮次拒绝引导时不能丢排队消息；本地 Stop 不能冒充官方已取消。
- 两个 Host TypeScript 项目及其引用编译通过。修改的 TypeScript 文件通过 staged Oxlint（0 错误，7 条已有的未使用禁用指令提示）。两组中英配对、文档字数和段落格式检查通过；全仓导出 JSDoc 检查仍报告原有 Claude Code 子代理文件的 8 处问题。
- 从归档提取干净文件，验证补丁可反向撤回、重新应用。应用后对 17 个文件逐一做 SHA-256 比对，与实际跑测试的源码一致。此前安装版的 [182 项合成回归](<antigravity-same-session.md#隔离验收>) 是另一套验证。

## 正式启用前

后续 ACP 接入已在隔离源码完成，见[原生会话源码验收](<dsh-antigravity-native-source.md>)。以下保留第一层补丁交付时的范围和验证计划。

本补丁只提供 Host 执行入口，合成执行器走通了原生轮次。下一步把「订阅增强」的官方 ACP 适配器、会话专用选模目录、文本输入限制和现有写作预设规则接到这个入口。还要在同一个原生页面验选模、草稿、列表、置顶、归档和搜索，再用签名版 Google CLI 实测登录、Stop、Windows 沙箱和工具审批。没有启动 Web 测试服务或专用浏览器；Windows 上游 Preview 的静态资源查找还存在 URL 分隔符差异，未用模拟页面代替实际验收。

先用独立测试 Profile 和合成工作区。旧 DSH 能读取这些 V4 日志，但不能在换模型后继续约束外部排队项的路由；不要拿测试会话给旧版续跑。正式使用前要解决旧读者兼容，并在长会话测 JSONL 检查点开销（目前两次检查各读取会话日志）。还需明确真实文字沿用 DSH 的历史、搜索、导出和远程可见范围，复核标题及压缩是否会额外发送正文。尚未运行全量产品构建、原生浏览器、双 SDK 快照和真实账号验收；补丁没有安装、发布或改动正在运行的 DSH。
