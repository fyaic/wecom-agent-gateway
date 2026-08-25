# 文档导航

- [`architecture.md`](architecture.md)：系统边界、数据流和包职责。
- [`official-wecom-ecosystem.md`](official-wecom-ecosystem.md)：企业微信官方及周边生态调研。
- [`interaction-cards.md`](interaction-cards.md)：Agent 交互卡片、Interaction Broker、状态机、UX 与里程碑。
- [`real-wecom-runbook.md`](real-wecom-runbook.md)：真实 Bot 凭据、白名单与收发联调手册。
- [`status.md`](status.md)：实际完成项、验证结果、未验证项和下一步。
- [`adapter-authoring.md`](adapter-authoring.md)：第三方 Kernel Adapter 的 v1 契约、能力语义与兼容矩阵。
- [`deployment.md`](deployment.md)：Linux/systemd、容器、健康检查和单实例生产边界。
- [`licensing.md`](licensing.md)：项目许可证、上游来源与第三方代码引入规则。
- [`public-release-checklist.md`](public-release-checklist.md)：切换公开可见性前的阻塞检查清单。
- [`releases/v0.1.0.md`](releases/v0.1.0.md)：首个 Public Preview 的发布说明与已知限制。
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

原始 `wecom-cli` 功能清单和测试台账仍由
[`CAPABILITY_TEST_MATRIX_2026-08-19.md`](https://github.com/fyaic/wecom-cli/blob/agent/capability-test-matrix/docs/fyaic/CAPABILITY_TEST_MATRIX_2026-08-19.md)
维护；本仓库只记录 Channel 与 Agent Runtime 相关验证，避免两个项目的测试口径混在一起。
