# ADR 0016：以官方 JSONL RPC 接入 Pi Agent

- 状态：Accepted
- 日期：2026-08-24

## 背景

Pi Agent 当前没有 ACP 接口。官方提供 `pi --mode rpc` 的 stdin/stdout JSONL 协议和同包 Node SDK；
RPC 已具备本项目需要的异步 prompt、图片、文本增量、完全终态、取消与持久 session 切换。把 Pi
伪装成 ACP 会制造错误的能力与 wire type，也会使后续协议升级不可控。

## 决策

新增独立 `adapter-pi` package，实现 Runtime Contract v1，固定
`sessionCompatibilityId=pi:rpc-v1`。Adapter 使用官方 RPC 语义：

- 启动有上限的受管 `pi --mode rpc` worker pool，不在 Core 中加载 Pi 类型；
- JSONL 严格只按 LF 分帧，允许 CRLF，并保留 JSON 字符串内合法的 U+2028/U+2029；
- `prompt` 成功只代表已接收，必须等待 `agent_settled` 才产生唯一 `message-completed`；
- `message_update.assistantMessageEvent.text_delta` 映射为流式增量，终态再用
  `get_last_assistant_text` 恢复可能漏掉的尾部；
- 图片从 Channel 的受保护临时文件读取为 base64；文件、音频和视频明确失败，不生成文字占位；
- `abort` 只作用于当前匹配的 opaque session；
- `select`、`confirm`、`input`、`editor` 等阻塞式 extension UI 未映射为产品能力，统一回复取消。

## Session 与并发

Pi RPC 一个进程只有一个当前 session。Adapter 使用有上限的长期进程池，默认
`PI_MAX_WORKERS=2`：新会话执行 `new_session`，恢复会话执行 `switch_session`；同一个 opaque
session 由 keyed lock 串行，不同 session 可以租用不同 worker 并行。每个 worker 仍一次只执行一个
run，进程数不会随会话数量增长。所有 worker 启动时必须报告相同的 Runtime Contract、capability
和精确输入模态，否则 Adapter fail closed。该设计避免并发 session switch 污染上下文，也消除了
单进程造成的跨会话队头阻塞。

opaque session handle 包含 Pi session file 与 session ID，只存入 Gateway 私有 session 映射，不进入
用户消息或普通日志。恢复前路径必须位于启动时推断或 `PI_SESSION_ROOTS` 显式配置的 root 内。

## 凭据边界

Pi 自己管理 provider、模型、工具与 transcript。Gateway 不复制 OpenClaw/Codex 的模型凭据，也不把
企业微信 Bot secret、SQLite 路径或全部宿主环境传给 Pi。子进程只接收基础进程环境和
`PI_AGENT_ENV_ALLOWLIST` 明确列名的 provider 变量。

## 验证

deterministic fake 覆盖 Runtime Contract 首轮/恢复、进程重启后的 `switch_session`、图片 base64、
取消、unsupported media、阻塞 UI 取消、非法 session root、严格 LF/U+2028/U+2029 framing、
同 session 串行、不同 session 并行和失败 worker 替换。真实 Pi `0.84.2` 两会话并发 smoke 为
6.373/6.876 秒，总墙钟 6.877 秒，确认发生重叠；受管服务强制重启前后均保持两个 worker，Adapter
ready 后 Bot 重新鉴权。企业微信私聊文本、恢复和 GLM-4.6V 图片验收也已通过。
