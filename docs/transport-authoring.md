# Channel Transport 接入指南

Transport 是 IM 厂商协议与 Gateway Core 之间的窄边界。它负责“怎样连接和投递”，不负责 Agent 推理、
模型选择、session 策略或办公工具。企业微信是首个生产参考实现；
[`transport-loopback`](../packages/transport-loopback) 是无厂商依赖的契约参考。

## 最小接口

实现 `ChannelTransport` 时必须声明：

```ts
import {
  CHANNEL_TRANSPORT_CONTRACT_VERSION,
  type ChannelTransport,
} from "@fyaic/wecom-runtime-contract";

export class MyTransport implements ChannelTransport {
  readonly id = "my-im";
  readonly contractVersion = CHANNEL_TRANSPORT_CONTRACT_VERSION;
  readonly capabilities = new Set(["proactive-message"] as const);

  async start(onMessage) {
    // 建立厂商连接，并把已归一化 InboundMessage 交给 onMessage。
  }
  async stop() {}
  async health() {
    return { ok: true };
  }
  async deliver(command) {
    // 只在本 Transport 已接受 command 后返回。
    return { id: "opaque-acceptance", acceptedAt: new Date().toISOString() };
  }
}
```

`DeliveryReceipt` 不是“用户已看到”或“厂商已永久保存”的证明。Core 的 SQLite/Outbox 负责 durable intent；
厂商回执、可见性和已读能力必须在该 Transport 自己的真实验收中单独描述。

## 能力声明

- `inputModalities` 非空时必须同时声明 `multimodal-input`、`media-download` 并实现
  `materializeInbound()`。
- `outputModalities` 非空时必须同时声明 `multimodal-output` 和 `media-upload`。
- `interactive-presentation` 依赖 `structured-presentation`。
- `reply-with-presentation` 依赖 `structured-presentation` 与 `stream-reply-update`。
- 不支持的能力必须不声明；Core 根据能力选择明确降级或在产生副作用前失败。
- 不得把厂商 frame、用户对象、卡片 JSON 或鉴权类型加入 Runtime Contract。

## 生命周期与身份

Gateway 会在启动 Adapter 和开放入站前运行 Transport 兼容检查。Transport 应在 `start()` 完成后才报告
healthy，并在 `stop()` 后停止新入站。`accountId`、`conversationId`、`senderId` 都是 opaque、安全相关
标识；显示名不能替代它们。单聊和群聊必须保持各自的稳定 conversation identity。

媒体临时文件由 Transport 物化并提供可重复调用的 `release()`；出站 durable artifact、重试和清理由
Core/Media Spool 管理。Transport 不得把临时 URL、AES key 或本地路径写入普通日志或 conformance 报告。

## Conformance

生产接口不提供“伪造用户消息”的方法。测试时另写一个 `TransportConformanceDriver`，用它注入已归一化
事件并观察 Transport 接受的命令：

```ts
const report = await runTransportConformance(transport, driver);
```

参考 loopback 的固定报告包含 22 个检查：生命周期、健康、单聊/群聊、引用、feedback、enter-chat、四种
输入媒体、普通/组合回复、主动文本/卡片、interaction update 和四种输出媒体。`passed`、`failed`、
`skipped` 不混淆，异常正文不会进入报告。

```bash
pnpm test:m3-transport
```

通过这层只证明中立 SPI；真实厂商仍需分别验证登录/重连、回调窗口、客户端显示、限流、媒体上传下载、
故障恢复和隐私边界。完整决策见
[`ADR 0028`](adr/0028-versioned-transport-spi.md)。
