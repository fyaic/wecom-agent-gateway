# ADR 0017：以受限 Unix Socket 提供 Kernel-neutral 主动消息控制面

- 状态：Accepted
- 日期：2026-08-24

## 背景

企业微信官方 SDK 和 Gateway Outbox 已支持 Bot 主动消息，但此前只有审批提示和入站 run 产生的媒体会
调用它们。Agent、定时任务或其他本地自动化若要主动联系用户，只能自行读取 Bot Secret、内部会话 ID
或直接操作 SQLite；这会破坏 Gateway 的凭据、目标授权和可靠投递边界。

主动消息是独立 IM Channel 的核心能力，不能绑定 Codex、OpenClaw 或某个 Agent 的私有工具协议。

## 决策

Gateway 可显式启用一个本机 Unix domain socket 控制面：

- socket 文件权限强制为 `0600`，不监听 TCP，不接受远端网络连接；
- 客户端只提交协议版本、动作、目标别名和文本或媒体描述；
- 客户端不读取 `.env`，不接收 Bot Secret、内部 account/conversation ID 或 SQLite 路径；
- 唯一 scoped 私聊和群聊自动获得 `direct` / `group` 别名；多目标必须在私有配置中显式映射；
- 每个映射的内部目标必须已经存在于对应的 direct-only sender 或 group-only conversation allowlist；
- 响应只返回动作类型、私聊/群聊类别以及 `delivered` / `queued`，不返回内部 ID；
- 文本和媒体都调用 Gateway Core 公共 API，在发送前进入同一 Outbox；媒体继续经过精确模态检查、
  允许根目录、spool、大小/哈希和清理流程；
- 单连接只接受一个有大小上限的 JSON 请求，超时和错误响应不回显请求内容。

控制面默认关闭。启用它表示当前 OS 用户被授权向预配置别名提交主动消息；生产部署可以进一步把
Gateway 放到专用 OS 用户或受限服务账户中。

## 非目标

- 不提供公网 HTTP API、Bot Secret 代理或任意会话 ID 发送接口；
- 不让 Gateway 决定 Agent 何时应主动联系用户；
- 不绕过企业微信频控、可见范围或官方 Bot 身份；
- 不保证 exactly-once；远端已接收但本地完成记录失败时仍遵循 at-least-once 语义。

## 协议 v1

请求动作：`health`、`send-text`、`send-media`。`send-media` 只接受绝对本地路径和 Runtime Contract
定义的 image/audio/video/file 类型。成功发送返回 `delivered`；已持久化但等待重试返回 `queued`。
协议不包含用户、会话、Outbox 或媒体内部标识。

## 验证

deterministic tests 覆盖 Core 主动文本/媒体持久化、立即失败后保留重试、精确输出模态、目标别名必须
属于 scoped allowlist、未知别名拒绝、媒体输入校验、credential-free health、响应脱敏、socket
`0600` 和停机清理。真实企业微信验收按联调手册分别对唯一授权私聊和群聊执行。
