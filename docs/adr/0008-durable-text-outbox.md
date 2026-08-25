# ADR 0008：文本投递采用租约式持久化 Outbox

- 状态：已接受
- 日期：2026-08-21

## 决策

所有 runtime-neutral 文本命令（`reply`、`proactive`）必须在调用企业微信 transport 前写入
`GatewayStore`。Gateway 使用 owner 租约认领命令：新命令优先立即发送，后台 worker 周期性
恢复到期命令和崩溃进程遗留的过期租约。成功后在同一事务内完成 outbox 并写入投递 journal；
失败按有上限的指数退避重试，达到最大尝试次数后进入死信。

同一条可变 Bot 回复的 pending 更新共享 `supersedeKey`。更新入队时，将尚未被认领的旧版本标记
为 `superseded`，从而在网络故障恢复后只发送最新文本。已 leased 的调用可能已经到达远端，不做
本地撤销。

## 语义

该方案提供 at-least-once，不提供 exactly-once。transport 已成功但本地完成事务失败时，命令在
租约过期后可能重放。企业微信回复更新应尽量使用稳定的 request/stream 语义吸收重放；主动消息
需要后续补充更明确的下游幂等能力和运营侧重复观测。

Outbox 只负责忠实传输与恢复，不改变 Agent 输入、输出正文、状态、模型、工具或路由决策。
重试失败不会阻塞 Agent 继续生成最终状态；最终版本可以替代尚未发送的中间版本。
发送调度按账户与会话串行，不同会话可以并发，避免一个慢会话阻塞整个 Gateway。

## 默认值与可观测性

- 轮询 1 秒、租约 30 秒、批量 10 条；
- 退避从 1 秒开始，单次最多 30 秒，最多尝试 5 次；
- 生命周期事件只有 `enqueued/delivered/retry-scheduled/dead-lettered`、命令类型和尝试次数；
- 错误日志走统一脱敏，不记录消息、会话或目标 ID。

所有默认值均可由 `GATEWAY_OUTBOX_*` 环境变量覆盖。

## 后续扩展

ADR 0009 后续把 `proactive-media` 以耐久 artifact 引用接入同一状态机，但绝不把 Agent 本地路径
写入数据库。本 ADR 的文本 supersede 语义不适用于媒体。多实例严格顺序、背压、死信重放管理
和人工告警仍不在本 ADR 的完成范围内。
