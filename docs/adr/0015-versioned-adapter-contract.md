# ADR 0015：版本化 Adapter 公共契约

- 状态：Accepted
- 日期：2026-08-24

## 决策

`AgentRuntimeAdapter` 必须声明数字型 `contractVersion`。当前唯一支持值为
`RUNTIME_CONTRACT_VERSION = 1`。Gateway Core 在构造期、任何 Adapter `start()` 或企业微信入站之前
执行运行时检查；不兼容版本和同一进程内重复的 Adapter ID 都直接失败。

TypeScript 类型用于本仓库编译期检查，运行时 guard 用于未来可能绕过 TypeScript 的 JavaScript、
动态加载或独立发布 Adapter。共享 testkit 在执行文本、流式和 session 恢复 contract tests 前也会
校验版本。

`contractVersion` 只描述 Gateway 与 Adapter 的公共语义。上游 wire protocol 另行固定：例如 ACP
v1、OpenClaw Gateway WebSocket v4 或 Codex App Server JSONL。`sessionCompatibilityId` 继续描述已
持久化 opaque session 的兼容范围；上游会话格式变化时可以只改变该值，无需虚假提升公共契约版本。

## v1 不变量

- 首轮成功 run 恰好产生一个 opaque session，恢复 run 不创建不同 session；
- 文本增量按顺序组成最终正文，成功 run 恰好完成一次；
- capability 只声明 Gateway 可以实际调用或转发的能力，不代表 Kernel 内部“可能拥有”某功能；
- 不支持的模态、工具或审批必须明确失败，不能静默丢弃或改写 Prompt；
- `start()`/`stop()` 只管理连接与进程，不创建语义 turn；
- vendor wire type 不进入 `runtime-contract` 或 `channel-core`。

只有破坏这些跨 Adapter 语义的变更才提升 major contract version。新增可选事件或 capability 优先在
v1 内向后兼容演进，并由共享 testkit 和兼容矩阵证明。
