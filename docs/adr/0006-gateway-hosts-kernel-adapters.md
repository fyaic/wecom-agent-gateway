# ADR 0006：Gateway 托管可插拔 Kernel Adapter

- 状态：已接受
- 日期：2026-08-20

## 决策

产品核心由 `Gateway Core + Adapter Host` 构成。每种 Agent Kernel 通过一个小型、可替换的
adapter 接入统一 runtime contract；Codex adapter 是第一份参考实现，不是核心特例。

Gateway 负责 adapter 生命周期：

1. 所有 adapter 完成 `start()` 后才开放企业微信入站。
2. Adapter 启动失败时保持入口关闭，并清理已经启动的 adapter。
3. 关闭时先停止 transport 入站，再排空已接收的会话队列，最后调用 adapter `stop()`。
4. 启动、就绪、失败、停止和单次 run 延迟分别产生不含会话内部 ID 的可观测事件。

## Adapter 可以做什么

- 启动或复用 Kernel 进程、SDK client、RPC/WebSocket 连接和连接池。
- 把通用 message、media、status、approval、cancel、session 事件映射到 Kernel API。
- 保存和恢复 Kernel 自己的 opaque session handle。
- 根据 Kernel 能力声明明确降级，并实施 adapter 内的超时、背压和错误翻译。

## Adapter 不可以做什么

- 改写用户输入，或注入改变 Agent 行为的 developer/system prompt。
- 用虚假用户消息预热线程，污染真实 session 或记忆。
- 判断用户意图、替 Agent 决定工具、模型、推理强度或回答内容。
- 将 Codex、OpenClaw 等 vendor 类型泄漏到 runtime-contract 或 channel-core。

因此，持久 Codex App Server、进程预启动或连接预建属于合法 adapter 优化；“发一条 hello
预热线程”不属于合法优化。启动过程只能建立基础设施状态，不能制造语义 turn。

## 延迟归因

端到端延迟按层拆分：Gateway 排队、Channel 首回执、Adapter 首事件、Adapter 首文本、最终
完成。`adapterId` 可以进入指标，用户/会话/message ID 不进入普通指标。只有在相同输入和
相同 Kernel 配置下完成分段测量，才判断缺陷位于 transport、core、adapter 或 Kernel。

正式分层复现中，Channel 首回执为 369–415ms。Codex 内置 provider 的首轮 Responses
WebSocket 在当前网络连续超时 5 次后才回退 HTTP，首文本为 113.7s；同一持久进程和 thread
的第二轮首文本为 5.2s。改用 ChatGPT-auth-compatible HTTP-only provider 后，独立冷轮首文本
为 6.7s、同线程热轮为 2.2s。由此确认分钟级延迟属于 Codex adapter 的上游传输冷路径，
不是企业微信 transport 或 Gateway core。随后真实企业微信私聊复测的 Channel 首回执为
452ms、Kernel 首文本为 3.88s、端到端完成为 5.12s。

HTTP-only 选择被封装在 Codex adapter 内，不进入 runtime contract。它不改变 Agent 语义，
并允许部署环境通过显式配置恢复官方内置 WebSocket provider。
