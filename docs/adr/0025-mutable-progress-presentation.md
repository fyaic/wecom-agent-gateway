# ADR 0025：动态状态文字与组合卡可见性边界

状态：Accepted
日期：2026-08-28

## 背景

企业微信 Bot 的流式回复协议允许在某一帧同时携带模板卡片。Gateway 已经能把 Adapter 显式发出的
status、emoji 与正文投影到同一条可变消息，因此曾尝试把停止控制放入首帧组合卡，以便任务完成时随
流式消息一起消失。

官方 `@wecom/aibot-node-sdk@1.0.7` 明确规定：`template_card` 在同一流式消息中只能回复一次；
`updateTemplateCard` 也只能在收到卡片 callback 后，使用该事件的 `req_id` 于五秒内调用，不存在无
callback 的主动原位更新接口。

2026-08-28 的真实 macOS 企业微信自动验收又补充了客户端事实：服务端接受首帧组合卡并返回成功，但
客户端只显示首帧文字，不显示卡片；把同一卡重复附带在后续帧虽然可能出现，却违反官方单次契约。
因此不能用服务端成功回执代替客户端可用性结论。

## 决策

- Adapter 显式 `status` 的 phase、text 和 emoji 只投影到可变文字，并与正文共享 250ms 合并和 durable
  supersede key。Gateway 不按耗时、文本或工具调用推断 Agent 状态。
- Core 不用首帧组合卡承载进度或运行控制；`reply-with-presentation` 仍是 Transport 的官方协议能力，
  仅供经过真实客户端认证的明确场景使用。
- Adapter 声明原生 `cancel` 且已有活动 session 时，阈值后通过独立 proactive card 提供 sender-scoped
  “停止本轮”动作；控制回调不进入模型解析。
- 任务自然完成后，平台没有无 callback 主动更新旧卡的能力。卡面必须明确限定为“本轮”；旧卡首次点击
  只原位显示已结束，重复、过期、跨 sender 或进程重启后的回调全部 fail closed。
- 完成时才获知的快捷 action 继续通过独立 proactive card 发送。

## 结果

- 状态与正文保持单消息、低噪声、Kernel 中立。
- 取消入口使用真实客户端已经验证可见、可点击的官方主动卡路径。
- 正常完成后可能看到一张生命周期已结束的控制卡，这是企业微信无 callback 更新边界；卡片无法误取消
  后续任务，且最终快捷卡清楚标志本轮已结束。

## 验证

- Core tests 覆盖纯文字状态投影、阈值主动卡、ACL、原生 cancel、正常完成/重复/过期的 fail-closed。
- WeCom Transport tests 继续覆盖官方 `replyStreamWithCard` 映射，但不把映射测试等同于客户端可见性。
- 2026-08-28 本机企业微信 UI 自动验收确认：首帧组合卡不可见；先前阈值主动停止卡真实可见并成功取消
  Pi run，Outbox 无积压或死信。
