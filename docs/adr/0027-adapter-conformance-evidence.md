# ADR 0027：Adapter Conformance 与证据分层

- 状态：Accepted
- 日期：2026-09-02

## 背景

仓库内参考 Adapter 共用 TypeScript 类型和测试并不足以证明 Runtime Contract 对外稳定。第三方 Adapter
需要一个不启动 Gateway、不连接企业微信、也不依赖 Core/Transport 的可执行入口；公开项目同时必须避免
把 capability 声明、deterministic fake、真实 Kernel smoke 和真实 WeCom E2E 混成一个“已支持”结论。

## 决策

新增独立 `@fyaic/wecom-adapter-conformance`：通过公共 `@fyaic/wecom-adapter-sdk` 装载 Adapter，按其声明
执行通用检查并输出 schema v1 JSON。检查结果只有 `passed`、`failed`、`skipped`：

- 未提供媒体 fixture、未显式允许产生副作用的 cancel probe，或必须由特定 Kernel fake 触发的能力一律
  `skipped`，不能由 capability 声明推断成功；
- 报告只含稳定 Adapter ID、公开 capability、模态和错误码，不含消息、回复、session、路径、用户/会话
  ID、上游异常正文或凭据；
- 通用 conformance 证明协议形状和可执行行为，不证明模型理解质量或企业微信链路；
- Adapter fake contract、真实 Kernel smoke、真实 WeCom E2E 是后续独立证据层，不能互相替代。

clean-room echo 示例的运行时代码只依赖公共 Adapter SDK。它通过文本、流式、恢复、引用、图片、回复动作
幂等和取消检查，固定 JSON 由 CI 重新生成比较。该示例证明扩展边界，不作为真实 Agent 宣传。

## 后果

- 新 Kernel 可以先在仓库外完成稳定、机器可读的兼容检查，再进入真实模型和企业微信验收。
- Conformance Kit 必须保持 vendor-neutral，不能包含 WeCom、Codex、Claude、OpenClaw 或其他上游类型。
- Claude Code 等新增参考 Adapter 必须先通过该层，再进入 README 的“已支持”矩阵。
