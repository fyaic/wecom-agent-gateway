# ADR 0002：核心使用运行时中立契约

- 状态：已接受
- 日期：2026-08-20

## 决策

`channel-core` 只依赖 `AgentRuntimeAdapter`、`AgentRunEvent` 等内部契约。Codex、Pi Agent、Kimi Code、OpenClaw 分别通过 adapter 接入。

## 原因

首个落地对象是 Codex，但最终产品需要支持多个 Agent Kernel。直接复用 OpenClaw Channel API 会让 session、approval、tool 和 streaming 语义锁死在单一宿主。

## 影响

通用契约只保留跨 runtime 可解释的能力；差异通过 capability 声明与 adapter 内部降级处理。
Adapter 可实现无语义的 `start()`/`stop()` 生命周期以托管进程或连接，不能用启动流程制造
Agent turn。新增 runtime 必须复用同一组 contract tests。
