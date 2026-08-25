# ADR 0005：Channel 忠实传输与可变消息呈现边界

- 状态：已接受
- 日期：2026-08-20

## 决策

本项目是企业微信 Bot 与 Agent Kernel 之间的 Channel Gateway，不是 Agent、Prompt
Router 或业务编排器。Codex 只是首个 contract test 和真实联调适配器，不定义核心语义。

Channel 可以处理传输和呈现策略：协议归一化、ACL、幂等、会话关联、顺序、重试、背压、
媒体搬运、能力协商、消息更新节流、审计和指标。Channel 不解释用户意图，不修改输入，
不注入语义性提示词，不决定模型、推理、工具或回答内容，也不伪造 Agent 的思考和情绪。

## 可变 Bot 消息

一次 Agent 回复对应一条持续更新的 Bot 消息：

1. Channel 在等待 Kernel 时立即发送中性回执 `⏳ 已收到，等待 Agent 响应…`。
2. 只有 Kernel 发出 `status` 事件时，才呈现 `thinking`、`tool-running`、emoji 或自定义状态。
3. `text-delta` 在 Channel 内合并并按时间窗口更新同一消息，避免闪烁和频控风险。
4. `message-completed` 将同一消息置为最终态；最终正文不保留临时状态。

中性回执描述的是链路状态，不声称 Agent 已经思考。状态 phase 的默认文案只在 Agent
明确发出该 phase 后使用；Agent 给出的 emoji 和文案原样优先。

## Kernel 能力协商

Adapter 通过 capability 声明 `streaming`、`status-events`、`multimodal-input`、
`multimodal-output`、`resume`、`cancel`、`approval` 和 `tools`。Transport 独立声明
流式消息更新、主动推送与媒体上传下载能力。Channel 只使用双方能力交集并执行显式降级。

## 路由边界

允许按 Bot、会话、租户或显式命令配置确定性选择 Kernel；不允许 Channel 根据自然语言
内容推断用户意图并替 Agent 选择行为。任何语义路由必须由上层 Agent 系统显式提供。

## 影响

- Kernel 启动、进程常驻、缓存和性能优化只能位于对应 adapter 内，且不得污染会话。
- `wecom-cli` 是 Kernel 可调用的办公工具层；Channel 只承载工具状态、审批和结果事件。
- 所有 Kernel adapter 复用相同 contract tests；Codex 专有类型不得进入 runtime-contract。
