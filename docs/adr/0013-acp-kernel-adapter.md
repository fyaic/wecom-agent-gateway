# ADR 0013：以 ACP v1 承载通用 Kernel 子进程

- 状态：已接受
- 日期：2026-08-24

## 背景

Codex 已证明企业微信 Bot 到 Agent 的链路可行，但单一真实 Adapter 不能证明 runtime contract 真正
中立。继续打磨 Codex 专有能力会让 Gateway 逐渐成为 Codex Channel，而不是独立 IM Gateway。

Kimi Code 已提供官方 `kimi acp` stdio 服务；Agent Client Protocol v1 定义了初始化、能力协商、
session、prompt、流式 update、取消、权限请求和多模态内容，适合成为第二 Kernel 的最薄接入面。

## 决策

新增独立 `adapter-acp` package，使用官方 `@agentclientprotocol/sdk` 的稳定 v1 入口。应用通过
Adapter Registry 显式选择 `codex`、`kimi` 或任意 `acp` 可执行程序；当前一个 Gateway 进程只
运行一个确定性 Kernel，不进行自然语言动态路由。

ACP Adapter：

- 启动受管子进程并在 Transport 开放前完成 `initialize`；
- 首轮使用 `session/new`，恢复使用 `session/load`，消息使用 `session/prompt`；
- 把 `agent_message_chunk` 映射为 `text-delta`，把工具状态映射为显式 `status`；
- 根据 Agent capability 启用 resume 和图片/音频输入，不支持的模态 fail closed；
- 将 cancel 映射到 `session/cancel`；
- 将 Agent 自有工具的 permission request 复用 Gateway 审批，保守按写操作处理；
- 只传递显式环境白名单，禁止 Bot secret 和无关 Gateway 配置进入 Agent 子进程。

ACP wire type 只存在于 Adapter package。`runtime-contract`、`channel-core`、WeCom Transport 和 Store
均不 import ACP 或 Kimi 类型。Codex 与 ACP Adapter 使用同一个 runtime-neutral contract testkit。

## 能力边界

ACP v1 没有与本项目 `RuntimeTool` 完全相同的通用 client-tool 注入机制。Kimi 自有工具可以请求
权限，但 `wecom-cli` catalog 不因此自动注入 Kimi。工具注入由各 Adapter 的明确 capability 决定，
不能为追求表面一致而把工具描述塞进 Prompt。ACP Adapter 收到非空 `RuntimeTool` catalog 时
fail closed，避免配置看似启用、实际被静默丢弃。

当前 Kimi ACP 声明图片输入、session load 和 cancel，不声明音频输入。文件和视频不能被静默转成
文本占位；未来应通过 ACP resource 能力或 Kernel 原生接口单独设计。

## 验证

2026-08-24：

- Codex 与 fake ACP Agent 通过同一套文本、流式和 session 恢复 contract tests；
- 本机真实 Kimi ACP 两轮 smoke 通过；
- 企业微信私聊文本经 Kimi 流式回复并保存独立 session；
- 同一私聊的图片由官方 WeCom SDK 解密物化后送入同一 Kimi session，回复成功且临时文件归零。

因此第二个真实 Kernel 已闭环，Gateway 的中立边界不再只是类型设计声明。
