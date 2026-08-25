# ADR 0020：Channel-neutral 结构化卡片与交互

状态：Accepted（Phase 1）  
日期：2026-08-25

## 决策

Runtime Contract 定义五类与 IM 厂商无关的 `Presentation`：通知、图文、按钮、投票和表单。
Agent Adapter 和 Gateway Core 不接收、生成或解释企业微信 `template_card` JSON；WeCom Transport
使用官方 `@wecom/aibot-node-sdk` 将通用结构映射为 `text_notice`、`news_notice`、
`button_interaction`、`vote_interaction` 和 `multiple_interaction`。

交互回调由 Transport 归一化为 `InboundInteraction`，继续经过 ACL 和入站幂等。Gateway 在 SQLite
持久保存卡片交互与业务控制项的关联，并绑定 account、conversation、sender 和失效时间。回调只能
消费一次；跨会话、跨发送者、重复和过期操作均 fail closed。

官方卡片更新要求在事件回调后五秒内完成，因此 `interaction-update` 是即时、尽力而为的 UI 更新，
不进入可延迟重试的 Outbox；业务决定本身先持久化，卡片更新失败不能撤销或重复执行副作用。初始卡片
仍经耐久 Outbox 投递。

## 首个闭环

写工具审批优先发送独立按钮卡片，提供“批准”和“拒绝”。点击后卡片原位更新为不可交互的结果通知，
同时解除正在等待的 Kernel tool call。Transport 不声明结构化交互能力时，继续使用精确
`/approve CODE` 与 `/deny CODE` 文本命令；自然语言永远不视作审批。

## 安全边界

- 卡片 ID 与 action/option ID 使用受限字符、长度和唯一性校验。
- 卡片链接仅允许无凭据 HTTPS；部署可配置 hostname allowlist。
- 交互回调不会作为普通用户消息交给 Agent，也不允许 Agent 决定 Gateway 控制面审批结果。
- SQLite 不保存企业微信 Bot secret、回调原始帧或 Agent 内部 session ID。

## 后续

Phase 1 提供五类确定性映射和审批交互闭环。后续如允许 Kernel 输出静态结构化内容或长期交互，必须
先定义独立的 Agent-facing 事件、恢复语义和授权策略，不能通过抓取模型文本中的厂商 JSON 实现。

## 2026-08-25 UX 修订

真实客户端证明，把少量单选按位置映射为横排按钮会截断文字，并让第一项 primary 蓝色产生错误的推荐
暗示。所有 `single-select` 因此统一映射为纵向 `vote_interaction`；等价候选保持中性，蓝色只表示提交
或显式 primary action。通用 action style 必须由调用方声明，Core 不从数组位置推断。

选项文案不按 SDK 建议长度静默截断。真实服务端对无跳转结果 notice 的 `card_action` 省略与 `{type:0}`
两种形式都返回 `42045`，因此完成态映射为 update-only 的禁用 vote checkbox：显示已完成、保留结果
摘要且不引入虚假 URL。服务端在 checkbox 禁用时仍要求 `submit_button.text`，省略会返回 `42049`；
因此保留“已完成”按钮，其重复回调由 Interaction Broker 幂等消费。真实复测确认该完成态可被服务端
接受，重复按钮动作只收敛 UI，durable resume 仍恰好一次。
