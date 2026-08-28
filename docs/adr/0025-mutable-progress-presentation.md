# ADR 0025：同消息动态进度阶段卡

状态：Accepted
日期：2026-08-28

## 背景

企业微信 Bot 的流式回复可以同时携带模板卡片。现有文字投影已经忠实展示 Adapter 显式状态，但阶段信息
与正文混排，且如果用独立主动卡呈现每个阶段会刷屏。最终回复快捷卡又已证明不能只在最后一帧首次加入，
否则真实桌面客户端可能静默丢卡。

## 决策

- 只有 Adapter 声明 `status-events`，且 Transport 声明 `structured-presentation` 和
  `reply-with-presentation` 时启用；应用默认开启，可用 `GATEWAY_PROGRESS_PRESENTATION_ENABLED=false`
  关闭。
- 第一帧在原可变回复中附加 Channel-neutral notice，表示请求已进入处理链路。后续只把 Adapter 显式
  `status` 的 phase、text 和 emoji 投影为卡片标题，不按耗时、文本或工具调用推断 Agent 状态。
- 整个 run 使用同一个 presentation ID，并与文字增量共用 250ms 合并和 durable supersede key；不发送
  独立进度消息，不创建 callback、Interaction Broker 记录或新 Agent turn。
- 标题在 Core 限制为 26 个 Unicode 字符，Transport 继续承担官方卡片的最终协议校验。
- 最终正文关闭原 stream。完成时才获知的回复快捷 action 仍通过独立主动卡发送。超过阈值的长任务在
  同一 stream 中把进度 notice 替换为停止 action，完成时随最终帧清除；它仍使用独立的 ACL、SQLite
  namespace 和原生 cancel 语义，不与进度展示混成同一种业务状态。

## 结果

- 用户在一条消息中看到请求接收、Agent 明确阶段和流式正文，不因阶段变化产生聊天噪声。
- Gateway 仍是忠实传输层，不成为 Agent 规划器或思考解释器。
- 不支持组合流或状态事件的 Kernel/IM 自动退化为原有纯文字可变回复。

## 验证

- MutableReply tests 覆盖首帧卡、状态/文字合并、同卡延续和最终帧清理。
- Core tests 覆盖 capability 交集、稳定 presentation ID、长标题边界、不产生主动进度卡和最终正文。
- WeCom Transport tests 覆盖官方 `replyStreamWithCard` 的 partial-frame template card 映射。
- Core tests 覆盖进度 notice → 停止 action 的同消息替换，以及正常完成后的无卡最终帧。
- 真实企业微信客户端的原位显示和最终态在部署后单列记录，不用 SDK 成功回执代替目视验收。
