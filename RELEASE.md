# Subscriptions Enhanced 0.1.8

首次公开 GitHub 安装版，固定验证 DSH 0.2.2-rc.3，基于 MIT 的 dsh-plugin-subscriptions 0.9.13。

- 保留 0.1.7 的 Antigravity 短重试、明确等待时间和 Gemini 身份文字调整。
- 四种模式由用户选择，不自动切换模式；原账号和额度逻辑保持。
- 清理作者电脑路径，补充上游声明、可复建脚本、版本安装包和 SHA-256。

通过 DSH 插件管理器安装 `.tgz`；原包名 `dsh-plugin-subscriptions-enhanced` 保持，继续使用当前电脑的原账号存储。原生管理器提示需要重启时，结束任务后重启 DSH。不要同时启用原订阅和其他同名 provider 实现。

构建核对固定上游 Host/Client SHA-256，后续升级必须重新审查补丁。停用增强后可恢复原版，上一版安装包可用于回退。

本版本未新增真实 Gemini 上游调用或已登录 GUI 验收。Remote Enhanced 未纳入本次发布。
