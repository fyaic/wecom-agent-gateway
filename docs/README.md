# 文档导航

## 先用起来 / Start here

维护者先看[产品目标与防偏航基线](product-intent.md)：判断任务是否仍服务于中间层主线。
本轮工程验收见[合并主审](reviews/mainline-integration.md)，下含传输、Claude 与 soak 的独立证据。

1. **第一次使用：** [中文接入指南](getting-started.md) / [English setup](getting-started.en.md)。
2. **解决什么问题：** [日常使用配方](use-cases.md) / [Everyday recipes](use-cases.en.md)。
3. **先看可信效果：** [真实 Agent 案例](verified-kernel-cases.md) / [English cases](verified-kernel-cases.en.md)。
4. **自己写适配器：** [示例导航](../examples/README.md) → [Adapter 开发](adapter-authoring.md) → [一致性验证](adapter-conformance.md)。
5. **不回复 / 变慢 / 投递失败：** [分层运行排障](gateway-status.md)。

## 按任务找文档

| 你现在要做什么                    | 阅读入口                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| 配 Bot、授权私聊 / 群聊、验收媒体 | [真实联调手册](real-wecom-runbook.md)                                                  |
| 让 Bot 主动通知或接收选择/确认    | [使用配方](use-cases.md)、[卡片交互](interaction-cards.md)                             |
| 让服务常驻、查健康与故障          | [部署](deployment.md)、[状态](status.md)                                               |
| 理解 Gateway / Adapter 边界       | [架构](architecture.md)、[Adapter 开发](adapter-authoring.md)                          |
| 核对哪些已测试，哪些不能宣称完成  | [证据规范](evidence-claims.md)、[实际状态](status.md)                                  |
| 参与下一阶段工作                  | [上手体验审计](onboarding-review.md)、[主线计划](ecosystem-watch-and-mainline-plan.md) |

## 完整参考索引

<details>
<summary>展开架构、运维、生态与发布文档</summary>

- [`getting-started.md`](getting-started.md) / [`English`](getting-started.en.md)：从全新 clone 到首条授权私聊的最短接入路径。
- [`verified-kernel-cases.md`](verified-kernel-cases.md) / [`English`](verified-kernel-cases.en.md)：Codex、Kimi、OpenClaw、Pi 与通用 ACP 的真实接入证据和复现入口。
- [`architecture.md`](architecture.md)：系统边界、数据流和包职责。
- [`official-wecom-ecosystem.md`](official-wecom-ecosystem.md)：企业微信官方及周边生态调研。
- [`ecosystem-watch-and-mainline-plan.md`](ecosystem-watch-and-mainline-plan.md)：近期同类项目、社区问题信号、主线差距与带退出条件的后续执行计划；后续优先级的主要参考。
- [`middleware-community-review.md`](middleware-community-review.md)：2026-09-05 新增同类中间层对照、Issue 痛点、落地改进与退出条件。
- [`upstream-compatibility.md`](upstream-compatibility.md)：官方 SDK/插件版本台账、上游问题采用状态与固定兼容回归矩阵。
- [`interaction-cards.md`](interaction-cards.md)：Agent 交互卡片、Interaction Broker、状态机、UX 与里程碑。
- [`real-wecom-runbook.md`](real-wecom-runbook.md)：真实 Bot 凭据、白名单与收发联调手册。
- [`status.md`](status.md)：实际完成项、验证结果、未验证项和下一步。
- [`evidence-claims.md`](evidence-claims.md)：实现、自动化、真实链路与完整认证的声明规范。
- [`adapter-authoring.md`](adapter-authoring.md)：第三方 Kernel Adapter 的 v1 契约、能力语义与兼容矩阵。
- [`adapter-conformance.md`](adapter-conformance.md)：独立 Adapter 一致性工具、机器可读报告、检查边界与 clean-room 证据。
- [`transport-authoring.md`](transport-authoring.md)：版本化 Channel Transport SPI、能力约束、送达层级和 loopback conformance。
- [`claude-code-adapter-evaluation.md`](claude-code-adapter-evaluation.md)：Claude Code 作为第五个参考 Kernel 的官方 SDK、协议映射、认证/条款边界与分阶段验收计划。
- [`deployment.md`](deployment.md)：Linux/systemd、容器、健康检查和单实例生产边界。
- [`licensing.md`](licensing.md)：项目许可证、上游来源与第三方代码引入规则。
- [`public-release-checklist.md`](public-release-checklist.md)：切换公开可见性前的阻塞检查清单。
- [`releases/v0.1.0.md`](releases/v0.1.0.md)：首个 Public Preview 的发布说明与已知限制。
- [`releases/v0.2.0.md`](releases/v0.2.0.md)：安全、可靠性与仓库治理收口的候选发布说明。

</details>

<details>
<summary>展开架构决策 ADR（保持编号与历史链接稳定）</summary>

- [`adr/0001-bot-only-identity.md`](adr/0001-bot-only-identity.md)：单一 Bot 身份决策。
- [`adr/0002-runtime-neutral-contract.md`](adr/0002-runtime-neutral-contract.md)：通用 Agent Kernel 边界。
- [`adr/0003-official-sdk-first.md`](adr/0003-official-sdk-first.md)：官方 SDK 优先决策。
- [`adr/0004-persistence-and-access-control.md`](adr/0004-persistence-and-access-control.md)：持久化与访问控制基线。
- [`adr/0005-channel-boundary-and-mutable-presentation.md`](adr/0005-channel-boundary-and-mutable-presentation.md)：忠实传输、Agent 状态与可变 Bot 消息边界。
- [`adr/0006-gateway-hosts-kernel-adapters.md`](adr/0006-gateway-hosts-kernel-adapters.md)：Adapter Host、生命周期和延迟归因边界。
- [`adr/0007-ephemeral-media-boundary.md`](adr/0007-ephemeral-media-boundary.md)：媒体下载、临时物化、Kernel 输入与清理边界。
- [`adr/0008-durable-text-outbox.md`](adr/0008-durable-text-outbox.md)：文本投递的发送前持久化、租约、重试、替代与死信语义。
- [`adr/0009-durable-media-spool.md`](adr/0009-durable-media-spool.md)：出站媒体的受控复制、artifact 引用、完整性、配额与崩溃恢复。
- [`adr/0010-bounded-admission-and-dead-letter-ops.md`](adr/0010-bounded-admission-and-dead-letter-ops.md)：入站容量、Agent 并发和受限死信重排边界。
- [`adr/0011-runtime-tool-registry-and-codex-dynamic-tools.md`](adr/0011-runtime-tool-registry-and-codex-dynamic-tools.md)：通用工具注册、Codex 动态工具协议与只读首切片。
- [`adr/0012-persistent-channel-approval-control.md`](adr/0012-persistent-channel-approval-control.md)：写工具的持久审批、会话/发送者绑定、超时与重启中断语义。
- [`adr/0013-acp-kernel-adapter.md`](adr/0013-acp-kernel-adapter.md)：标准 ACP v1 Kernel 子进程、能力协商、会话和环境隔离边界。
- [`adr/0014-openclaw-gateway-adapter.md`](adr/0014-openclaw-gateway-adapter.md)：OpenClaw 公共 Gateway WebSocket、模型凭据边界与终态对账。
- [`adr/0015-versioned-adapter-contract.md`](adr/0015-versioned-adapter-contract.md)：Adapter 公共契约版本、启动期拒绝与升级规则。
- [`adr/0016-pi-jsonl-rpc-adapter.md`](adr/0016-pi-jsonl-rpc-adapter.md)：Pi 官方 JSONL RPC、有界 worker pool、严格分帧与交互边界。
- [`adr/0017-local-proactive-control-plane.md`](adr/0017-local-proactive-control-plane.md)：无 Bot Secret 的本地主动消息控制面、别名授权与耐久投递。
- [`adr/0018-external-adapter-sdk.md`](adr/0018-external-adapter-sdk.md)：可信外部 Adapter 模块、公共工厂契约和动态装载边界。
- [`adr/0019-operational-observability.md`](adr/0019-operational-observability.md)：loopback 健康/就绪端点与无用户数据 Prometheus 指标。
- [`adr/0020-channel-neutral-structured-cards.md`](adr/0020-channel-neutral-structured-cards.md)：五类通用卡片、官方 SDK 映射和审批按钮闭环。
- [`adr/0021-durable-interaction-broker.md`](adr/0021-durable-interaction-broker.md)：五秒 fast lane、耐久交互状态与 deferred resume。
- [`adr/0022-live-kernel-interaction-resume.md`](adr/0022-live-kernel-interaction-resume.md)：原生 ask-user、live control resume 与文本输入范围。
- [`adr/0023-final-reply-actions.md`](adr/0023-final-reply-actions.md)：最终流式回复快捷操作、主动降级与真实 callback continuation。
- [`adr/0024-long-run-cancel-control.md`](adr/0024-long-run-cancel-control.md)：长任务取消卡、原生 cancel、ACL 与一次性状态边界。
- [`adr/0025-mutable-progress-presentation.md`](adr/0025-mutable-progress-presentation.md)：动态状态文字与官方组合流的真实客户端边界。
- [`adr/0026-single-bot-process-ownership.md`](adr/0026-single-bot-process-ownership.md)：单 Bot 本机进程所有权、崩溃回收与 active-active 前置边界。
- [`adr/0027-adapter-conformance-evidence.md`](adr/0027-adapter-conformance-evidence.md)：外部 Adapter 一致性报告和四层证据口径。
- [`adr/0028-versioned-transport-spi.md`](adr/0028-versioned-transport-spi.md)：版本化 Transport SPI、接受回执语义与 loopback 证据。

</details>

原始 `wecom-cli` 功能清单和测试台账仍由
[`CAPABILITY_TEST_MATRIX_2026-08-19.md`](https://github.com/fyaic/wecom-cli/blob/agent/capability-test-matrix/docs/fyaic/CAPABILITY_TEST_MATRIX_2026-08-19.md)
维护；本仓库只记录 Channel 与 Agent Runtime 相关验证，避免两个项目的测试口径混在一起。
