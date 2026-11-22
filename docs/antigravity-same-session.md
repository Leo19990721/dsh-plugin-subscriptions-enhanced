# 在同一个会话切换 Antigravity

公开 rc.5 源码上的接入已通过合成测试，见[原生会话源码验收](<dsh-antigravity-native-source.md>)。本页保留此前独立的安装版运行时试验。

## 隔离验收

隔离实现沿用一个普通 DSH 会话。原生选模改为 Antigravity 后，下一轮走 `agy acp` 协议；已经开始的轮次仍由原后端处理。切回 DSH 模型时继续使用同一个会话 ID。切换只记录本会话的选择，不创建用户可见会话、不改全局默认，也不增加选择确认。

[安装版回归](<../tests/agy-native-turn.test.mjs>)以 DSH Desktop `0.2.2-rc.5` 的原生会话控制器、Agent Loop、连接、Gateway、会话共享缓存、JSONL 和搜索为基础。有两个类在内存中接入轮次分流；[夹具](<../tests/fixtures/dsh-turn-runtime.mjs>)先核对对应安装构建的版本、SHA-256 和唯一代码位置。测试用独立临时目录和合成消息，未启动替换服务、未修改 ASAR 或活动配置。使用 Codex 路由名的合成适配器验证 DSH 的原生工具续步，未调用真实 Codex。

- 在一条会话连续走四轮 DSH、Antigravity、DSH、Antigravity。第二次进入 Antigravity 加载原官方会话，交接其间的新对话；DSH 回读前一轮 Antigravity 回复。原生列表、置顶、归档、搜索都沿用同一个会话。
- 在 DSH 工具执行时改选 Antigravity。已经开始的工具及后续模型步骤仍由 DSH 处理，下一条输入才交给 ACP。
- 在 ACP 轮运行时切回 DSH，原生 Stop 仍发给这一轮的 ACP。它会保留随后到达的文本，等待官方终态；原生队列按 Stop 的规则保留。重开后从 DSH 持久日志恢复可见内容，不再次显示官方加载返回的副本。
- [异常回归](<../tests/agy-turn-boundaries.test.mjs>)覆盖本机窗口以外的选择、发送、编辑和 Stop，也验证了归档、工作区移除、非文本输入、断线、最终保存失败，以及已记待确认但尚未发送时的 Stop。原生调度走普通 DSH 的手动投递正常。
- Stop 后排队的 ACP 项可在本机原地编辑或移除。收到一条新的本机消息后，会按原顺序继续；重复回执不唤醒。试验环境运行时最多等候七条同一选择的 ACP 输入，预留一个位置给停止后用于恢复队列的新消息。排队项不能改投其他模型。冷重开找不到原请求的内存凭据，保留排队项供用户移除，不会自发执行。
- 恢复同一官方会话时，已知的默认思考档位会通过 CLI 重新确认。收到 ACP 终态前的尾片保留；同一批次中排在终态后的文本不会混进回复。停止后断线仍保留已看到的文本，并记录为结果未确认。

老的独立会话试验保留在[历史验收](<gemini-native-acceptance.md>)。这次验收不依赖那条入口，也不替换已有的试验包。

## 数据怎么交接

[上下文投影](<../src/agy-turn-context.js>)只取已完成轮次中符合条件的可见用户和助手文字。跳过系统和运行环境提示、工具参数和结果、结构化附件、定时任务以及未完成轮次。正文作为独立 ACP `text` 块发送，最多 32 KiB（按 JSON 转义后的 UTF-8 字节计数）；新输入紧随在另一块。原服务的内部会话状态留在原服务。如果用户把敏感信息写进可见正文，正文过滤不能识别所有敏感内容。

[轮次记录](<../src/agy-turn-ledger.js>)保存 DSH 会话身份、工作目录、官方会话 ID、最后确认的事件位置和待确认轮次。先保存本轮 DSH 输入，再记录待确认，最后才发 ACP。收到官方终态并保存 DSH 的轮次结束事件后，清除待确认、推进位置。连接中断后原样保留待确认；不重发，也不会替这条消息改走普通模型。用户可移除未执行的队列项，再选回普通模型写新消息。

切入 ACP、提交消息、编辑 ACP 队列和按 Stop 停止 ACP 轮次，都会核对当前本机窗口的请求身份。已获授权的原生归档操作和 Agent 释放仍能停止工作。调度、子代理和其他入口不能借用这一发送权限。

同一个 DSH 会话意味着合成 Antigravity 文字按普通原生消息进入 DSH 历史、搜索和会话缓存。产品开放前，要明确告知真实内容沿用原生的可见范围，并拿真实导出、远程读取、自动标题和压缩请求验一次，防止新增未预期的外发。

## 输入框验证

- **选模只针对本机打开的会话。** 隔离 Host 接受 `session.modelCatalog({ audience: 'conversation', sessionId })`；只有通过本机浏览器请求身份校验、且对应一个允许切入的在线普通会话，才追加 Antigravity 分组。请求的用途字段只选目录，不能授予权限。子代理设置现有的无参数调用继续拿普通目录。查询不打开会话、不启动 CLI。Antigravity 没有注册成普通 LLM 提供方，切入或切出都不写全局默认。见[选模和权限回归](<../tests/agy-turn-boundaries.test.mjs>)。
- **拒绝发送时保留草稿。** [草稿测试](<../tests/agy-native-composer.test.mjs>)执行安装版原生提交状态机和浏览器请求封装，使用合成草稿、选模和回执验证同一个 Session 的拒绝、重试与接受。草稿有附件或需要展开的语义引用时，纯文本策略会在测试的上传或序列化入口停止，保留原草稿；可见引文仍可作为文字发送。`/model` 仍先走原生命令判定。没有运行 Lexical 编辑器、模型菜单或真实页面，草稿验证不包含浏览器刷新和光标位置。
- **在保存附件前拦截。** [上传回归](<../tests/agy-turn-uploads.test.mjs>)使用原生上传路由和真实附件库，把存储限制在测试目录。ACP 生效后，新的原始文件、图片和 Base64 文件都在保存前被拒绝，流式请求未读取正文，存储目录也未创建。已经在 DSH 模式受理的上传可以完成；ACP 不读取或消耗它的收据，切回 DSH 后同一会话还能发送原附件。这里的拒绝点在 Host 读取和保存流之前；浏览器端仍要在选择、粘贴、拖放和重试时停止发起上传。

安装版回归 **182 项通过，无跳过**。复跑方式见[安装版测试入口](<gemini-native-acceptance.md#L21-L37>)。现用 Desktop、活动配置和原试验包保持不变。

## 正式启用还缺什么

整轮执行入口已在公开 rc.5 源码中实现并通过合成测试，见[源码补丁及复跑说明](<dsh-turn-executor-patch.md>)。以下保留安装版隔离验证时对公开基线的核对和后续接入要求。

2026-11-20 核对：本机是 `0.2.2-rc.5`，构建 `3f85d888b1297107937d9bd5b853f7e733e179a4`。官方公开 [master](https://github.com/deepseek-ai/deepseek-harness/commit/2e39e70496aa02986ca6a820c5d497e816b69d7e) 和 [rc.5 标签](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5)仍缺整轮接管、按会话隔离的选模目录和保存前的附件准入。隔离入口只挂在测试中；[发布包构建](<../scripts/build.mjs#L25-L27>)仍挂载原有[状态入口](<../src/agy-host.js#L289-L293>)。

1. **给原生 Agent Loop 一个整轮执行入口。** [当前循环](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/core/agent-loop/src/agent.ts#L289-L438)先认领输入、解析工具和组装提示，`agent/pre-step` 随后才运行。需要在这些动作前选定执行方，沿用原生队列、取消信号、事件和归档检查；当前轮次不受菜单改选影响。接线时应保留[写作预设的模型限制](<../src/writing-host.js>)和普通模式，避免通过切模型改预设。
2. **在 DSH 原生输入框接入会话目录和纯文本能力。** [会话选模](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/client/ui-model-selection/src/client/catalog.ts#L43-L68)和[子代理设置](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/client/ui-settings-subagent/src/client/subagent-model-selection-card-controller.ts#L315-L326)仍读同一个无参数目录。正式接线要让输入框和 `/model` 共用本会话的目录；在全局默认和子代理最终选路处也拒绝这类仅供会话使用的模型。文件选择、粘贴、拖放、重试、转换为路径引用以及提交前都要读取会话能力。异步准备期间如果切了模型，用同一选择版本在 Host 复核，避免已经展开的引用被当成新模型的纯文本发送。拒绝时保留草稿和删除附件的操作，提示用户移除附件或切回原模型，沿用现有输入框反馈，不加切换确认。页面验收再覆盖光标、草稿、键盘选模和队列，不改全局 Enter 偏好。
3. **用签名官方 CLI 验真实登录和工具权限。** 由用户在官方 CLI 登录，使用专用测试目录验证实际模型和选项、Windows 沙箱、权限审批、Stop 和退出。工具回归使用合成文件。只有已知的模型初始档位可用作默认值。ACP 初始化握手见[历史验收](<gemini-native-acceptance.md#L11>)；真实模型请求尚未运行。
