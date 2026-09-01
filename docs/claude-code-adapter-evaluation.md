# Claude Code Kernel Adapter 评估

决策日期：2026-09-01。状态：**纳入参考 Kernel 范围，尚未实现或对外声明支持**。

## 决策

Claude Code 应成为 Codex、ACP/Kimi、OpenClaw、Pi 之后的第五个参考 Kernel。它是主流 coding agent，
也能检验 Runtime Contract 是否真正与 Codex/OpenClaw 的协议假设解耦。

实现仍按主线顺序进入 M3.2：先完成 M3.0 的企业微信真实客户端和上游兼容收口，再开发独立
`@fyaic/claude-code-runtime-adapter`。不会为了增加 Kernel 数量打断 IM 保真、投递可靠性和生产认证。

首选上游接口是官方
[`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript)，
不是终端 PTY 抓取，也不是直接调用 Messages API 后自行重写 Agent loop。2026-09-01 的 npm 快照为
Agent SDK `0.3.252`、Claude Code `2.1.252`；实现时仍须固定精确版本并重新审计 changelog。

## 为什么值得纳入

官方 [Agent SDK 概览](https://code.claude.com/docs/en/agent-sdk/overview) 明确把它定义为基于 Claude Code
能力构建自定义 Agent 的程序化接口。它与当前 Runtime Contract 的关键语义能够直接对齐：

| Runtime Contract 需求  | Claude 官方接入面                                                                      | 初步映射决定                                                         |
| ---------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 增量文本               | `query()` async generator；`includePartialMessages` 提供 `stream_event` / `text_delta` | `text-delta`；最终只由成功 `result` 收口，避免 assistant/result 重复 |
| session 创建与恢复     | init/result 含 session ID；`resume` 继续上下文；`forkSession` 显式分叉                 | opaque `sessionId`；Gateway 不读取 transcript                        |
| 取消                   | `Options.abortController`                                                              | `cancel(sessionId)` 只 abort 当前 live query，重复调用安全           |
| 图片输入               | streaming input 的 `SDKUserMessage` 支持 base64 image block                            | 首切片只声明 `image`；从受保护 artifact 读取                         |
| 工具审批               | `canUseTool` 可返回 allow/deny，并带 `AbortSignal`                                     | 映射 Gateway approval；不使用 `bypassPermissions`                    |
| 原生 ask-user          | `AskUserQuestion` 通过 `canUseTool` 提供 1–4 个问题及选项                              | 映射 `RuntimeInteractionRequest`，保持 live call，不合成用户 Prompt  |
| 长等待与恢复           | callback 可等待；官方也支持通过 hook `defer` 后从持久 session 恢复                     | 先实现有界 live resume；durable defer 另做 crash/restart contract    |
| 启动延迟               | `startup()` 可预热 CLI 子进程并完成 initialize handshake                               | 用于 Adapter `start()`；不发送虚假 hello 或创建语义 turn             |
| 权限与配置             | `permissionMode`、allow/deny rules、hooks、`settingSources`                            | 明确传入最小设置和环境；不继承 Bot secret 或整个宿主环境             |
| 跨主机 session（可选） | 官方 `SessionStore` 支持外部 transcript storage；默认 session 在本机                   | 不在首切片引入；与 M3.1 ownership/store 决策一起评估                 |

官方参考：

- [TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)
- [Streaming input and images](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Sessions and resume](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Permissions](https://code.claude.com/docs/en/agent-sdk/permissions)

## 推荐架构

```text
WeCom Transport
      │
Channel Core ── Runtime Contract v1
      │
Claude Code Adapter（独立 package）
      │
official Claude Agent SDK query()/startup()
      │
unmodified Claude Code process + user-owned credential
```

Adapter 只翻译协议：

- `agentInputParts()` 保留当前消息和引用消息的有序文本/图片；不把文件静默改写成自然语言占位。
- `stream_event/text_delta` 进入可变 WeCom reply；成功 `result` 进入 Core durable final outbox。
- SDK 显式 tool/activity 只能产生面向用户的有限状态，不输出 thinking、chain-of-thought 或默认转发 subagent 文本。
- `canUseTool` 中的普通工具权限进入 approval control；`AskUserQuestion` 进入 Interaction Broker。
- SDK 错误分类转换为有界、无凭据的失败；认证、rate limit、overloaded 和模型不可用保持可诊断区分。
- session、工作目录和 live query 由 Adapter 管理；Bot ID、conversation ID、tool input 和 transcript 不进入普通日志。

不采用：

- PTY/ANSI 抓屏、解析终端自然语言或依赖 TUI 布局；
- 直接调用 Anthropic Messages API 并在 Gateway 内重造 Claude Code 的工具循环、session、权限或 hooks；
- 把 Claude Code 的 SDK types 放入 `runtime-contract` 或 `channel-core`；
- 通过 Prompt 模拟取消、审批、AskUserQuestion 或 session 恢复；
- 默认开启 `bypassPermissions`、自动批准 destructive tool，或把宿主全部环境变量传给子进程。

## 认证、条款与发布边界

Claude Agent SDK 与 Claude Code 并非按本项目 MIT 许可证重新授权。官方仓库声明其使用受
[Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms) 约束；
[Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) 还明确要求：

- 不修改 Claude Code binary；
- 每个最终用户使用并承担自己的 Anthropic API key、Claude 订阅或受支持云厂商凭据；
- 不替用户支付、转售或中介 Claude usage；
- 不收集、保存或代理用户的 Claude.ai credential/session token；
- 第三方产品默认应使用 API key 或受支持云厂商认证，不能把共享 Claude.ai 登录/额度作为产品能力。

因此计划中的 Adapter：

1. 作为可选 Kernel package，固定并保留上游包自己的条款；项目 MIT 只覆盖本仓库原创 Adapter 代码。
2. 发布说明明确“用户自备并直接管理凭据”；Gateway config 不接收 Claude OAuth token，Bot 配置也不包含它。
3. 默认生产文档使用用户自己的 API key、Bedrock、Vertex、Foundry 或其组织允许的认证方式。
4. 本地个人 smoke 可以使用用户已经在未修改 Claude Code 中完成的登录，但这不是可转售或共享的认证方案。
5. 在加入依赖前更新 lockfile license inventory、`THIRD_PARTY_NOTICES.md` 和公开发布检查；若条款无法满足，
   保留外部 Adapter 示例而不把 SDK 打进默认发行物。

这只是工程与发布边界，不替代使用者或发布方自己的法律审查。

## 分阶段验收

### C0：协议 spike

- 固定 SDK/Claude Code 版本，使用 deterministic fake 验证 init、delta、result、error、resume 和 abort。
- 验证 SDK 包/二进制的安装、条款、可选依赖和最小运行环境；不加入默认 Gateway 启动路径。
- 记录 `startup()` 对 subprocess-ready 和首文本延迟的分层改善，不发送模型预热 Prompt。

### C1：安全文本闭环

- 本机两轮文本、同 session resume、取消、重启恢复和认证失效诊断。
- 企业微信授权私聊和群聊各一轮；首事件、首文本、完成和 durable delivery 分层计时。
- 默认权限不能 bypass；审批拒绝时工具零执行，最终态唯一。

### C2：媒体与交互

- 图片及引用图片保真；不支持的 file/audio/video 在进入 Kernel 前 fail closed。
- `AskUserQuestion` 单选、多问题和取消/过期；`canUseTool` allow/deny；重复 callback 幂等。
- live 进程中断后不伪造 Prompt；只有验证官方 defer/session 恢复语义后才声明 durable interaction resume。

### C3：对外证据

- 通过独立 Adapter conformance kit，更新真实 Kernel case、版本矩阵、许可说明和脱敏截图/时间线。
- 只有 C0–C2 全部通过后，README 才把 Claude Code 放入“已支持”，此前始终标记 planned。

## 与主线的关系

Claude Code 不改变项目边界，也不改变当前优先级：

- M3.0 继续先完成 WeCom 引用、审批异常、视频和上游兼容矩阵。
- Claude Code 属于 M3.2 Adapter 生态，作为下一新增参考 Kernel 的第一候选。
- 实现中发现的通用 Contract 缺口必须先证明对至少两个 Kernel 有意义，不能为了 Claude 私有字段污染 Core。
- 卡片只是承载审批/提问的可选 WeCom Presentation；Claude Code Adapter 不生成企业微信卡片 JSON。
