# ADR 0011：通用工具注册与 Codex 动态工具桥

- 状态：已接受
- 日期：2026-08-21

## 决策

Gateway 使用运行时中立的 `RuntimeTool` 契约描述工具名称、说明、JSON 输入 schema、副作用等级、
审批要求和执行函数。`channel-core` 不解释工具名称、参数、结果或用户意图；每个 Kernel adapter
只负责把该契约翻译成自身协议。

Codex 参考 adapter 使用官方 App Server 的实验性 `dynamicTools` 与 `item/tool/call` 流程：只有
配置了工具时才在 `initialize` 中声明 `experimentalApi`，新 thread 携带工具 schema，客户端收到
调用后执行精确注册的函数并返回结构化内容。

第一阶段只注册 `wecom_contact_search`：它固定映射到官方 `wecom-cli contact users search
--json ...`，使用 `execFile` 而非 shell。模型只能提供 schema 中的联系人关键词与可选 `list`
模式，不能提供命令路径、任意 argv、环境变量或可执行文件。

## 安全边界

- Codex 动态工具桥只接受 `read-only + approval=never` 或
  `write/destructive + approval=required`；不安全的组合在 adapter 构造时失败。
- 输入由具体工具再次校验，不依赖模型遵守 JSON Schema。
- 工具运行与输出都有独立超时/大小上限；失败只向 Kernel 返回通用错误，详细诊断只进入本地脱敏日志。
- 工具生命周期只记录工具名、副作用等级、阶段和耗时，不记录参数、结果或任何会话/调用标识。
- `wecom-cli` 使用独立授权配置目录；Bot secret 不传给工具，真人授权凭据也不进入消息、数据库或普通日志。
- 联系人结果中的内部 ID 只允许工具间内部流转，不得出现在最终用户回复。
- Codex 动态工具 catalog 的稳定哈希参与 session 持久化 scope；catalog 变化会创建新 thread，避免
  恢复一个缺少新工具或带旧 schema 的不兼容 thread，同时保留旧记录供审计。

## 影响

写操作不会为了“功能完整”而提前开放。Gateway 审批回路完成后，仍须逐个注册消息、文档、日程
等显式业务工具，并分别完成真实批准/拒绝验收。禁止新增一个接收自由 argv 的
`wecom_cli` 万能工具。

官方协议把动态工具标为实验接口，因此 Codex adapter 保持窄映射与独立 contract tests；Pi、
Kimi、OpenClaw 后续复用 `RuntimeTool`，不复用 Codex wire type。
