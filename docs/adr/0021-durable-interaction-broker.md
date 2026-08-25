# ADR 0021：耐久 Interaction Broker 与 deferred resume

状态：Accepted  
日期：2026-08-25

## 背景

ADR 0020 建立了 Channel-neutral Presentation 和审批按钮闭环，但 choice/form 回调尚未恢复 Agent。
企业微信要求模板卡片事件在五秒内更新；人类响应时间又可能远超 Kernel tool call、进程或连接的生命
周期。将 Agent run 持续挂起不是通用且可恢复的基础。

## 决策

Gateway Core 承担一个与 WeCom 无关的 Interaction Broker：持久保存请求、目标发送者、会话、TTL、
结果和 Adapter continuation；回调先原子决定并更新 Channel UI，再通过带租约的 durable resume queue
异步恢复 Adapter。

默认 continuation 是 deferred suspend/resume。Adapter 可以用原生 elicitation 或受控工具生成请求，
但必须把它归一化为 Runtime Contract；回调结果也以结构化 result 恢复，不伪装为普通用户文本。
原生 inline-await 只能作为 Adapter 声明 capability 后的优化。

## 结果

- 五秒回调路径不依赖 Kernel 可用性或推理速度。
- 进程重启不丢待回答交互和已提交但未交付的结果。
- Runtime resume 使用租约、重试、dead letter 和稳定 idempotency key，语义为 at-least-once。
- callback frame 只用于即时卡片更新；Agent 续跑输出使用新的主动消息。
- 普通 elicitation、Gateway approval 和注册 workflow action 使用独立 namespace，不能互相授权。

## 非目标

- M2.1 不实现群聊公开投票或 exactly-once Kernel 执行。
- M2.1 不要求任何真实 Kernel 支持 ask-user；先由 deterministic adapter 证明 Broker 状态与恢复。
- 不接受 Agent 生成的 WeCom JSON、task ID、callback key 或目标用户 ID。
