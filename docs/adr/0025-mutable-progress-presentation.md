# ADR 0025：首帧单卡与动态状态文字

状态：Accepted
日期：2026-08-28

## 背景

企业微信 Bot 的流式回复可以在第一帧同时携带模板卡片。现有文字投影已经忠实展示 Adapter 显式状态，
但希望用卡片阶段进一步丰富 UX。真实客户端验收先后暴露了两个问题：阈值后独立发送的停止卡会在任务
正常结束后残留；在同一 stream 中把 `text_notice` 改成 `button_interaction` 又不可靠。

官方 `@wecom/aibot-node-sdk@1.0.7` 明确规定：`template_card` 在同一流式消息中只能回复一次。
`updateTemplateCard` 也只能在收到卡片 callback 后，使用该事件的 `req_id` 于五秒内调用；不存在无 callback
的主动原位更新接口。

## 决策

- `reply-with-presentation` 表示第一帧最多携带一个 Channel-neutral Presentation，不表示后续帧可以换卡。
- Adapter 显式 `status` 的 phase、text 和 emoji 只投影到可变文字，并与正文共享 250ms 合并和 durable
  supersede key。Gateway 不按耗时、文本或工具调用推断 Agent 状态。
- 已有可恢复 session、Adapter 声明原生 `cancel` 且 Transport 支持交互组合卡时，第一帧直接附带
  sender-scoped 停止 action；最终帧不再携带卡片，客户端自然清除。
- 首轮尚无 session 时不伪造可取消能力，可使用一次中性 notice；不支持组合流的 Transport 才在阈值后
  使用独立主动停止卡降级。
- 完成时才获知的快捷 action 继续通过独立 proactive card 发送，不尝试塞入最后一帧。

## 结果

- 用户在一条消息中看到显式状态文字与流式正文，不因阶段变化产生聊天噪声。
- 取消入口遵守官方首帧单卡契约，正常完成后不遗留“仍在执行”卡。
- Gateway 仍是忠实传输层，不成为 Agent 规划器或思考解释器。
- 新 session 的首轮取消能力弱于恢复轮，但不会声称一个尚不存在的 session 可被原生取消。

## 验证

- MutableReply tests 覆盖 presentation 只出现在第一帧、状态/文字合并和无卡最终帧。
- Core tests 覆盖中性首帧、已有 session 的首帧停止 action、纯文字降级和最终清理。
- WeCom Transport tests 覆盖官方 `replyStreamWithCard` 第一帧映射。
- 本机企业微信 UI 自动验收负责确认按钮真实可见、点击取消和最终无陈旧卡；不以 SDK 成功回执冒充
  客户端可见性。
