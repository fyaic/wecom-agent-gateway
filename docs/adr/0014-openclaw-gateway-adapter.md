# ADR 0014：通过公共 Gateway WebSocket 接入 OpenClaw

- 状态：Accepted
- 日期：2026-08-24

## 决策

新增独立 `adapter-openclaw` package，通过官方
[`@openclaw/gateway-client`](https://www.npmjs.com/package/@openclaw/gateway-client) 连接一个已运行的
OpenClaw Gateway。Adapter 使用公共 WebSocket v4 控制面，不加载 OpenClaw 插件、不读取其内部
配置文件，也不把 OpenClaw 类型引入 `runtime-contract` 或 `channel-core`。

OpenClaw 继续独立拥有 Agent、模型、工具、工作区和 transcript。本项目只负责：

- `chat.send` 与 runtime-neutral 输入的转换；
- `chat` 事件到状态、文本增量和完成事件的转换；
- `chat.abort` 取消；
- session key 的创建、恢复和 Gateway Store 映射；
- 本地已物化媒体到官方 attachment 的无语义转换。

模型由 OpenClaw 自身选择。Adapter 不包含 Codex 登录或 GLM/OpenAI 等 provider 配置，也不接触模型
API Key；它只需要 OpenClaw Gateway 的客户端认证。首版只允许 loopback WebSocket，并要求 token 或
password，避免在尚未实现 TLS、设备配对和远端信任策略前意外开放控制面。

`chat.send` 是异步确认接口，正常输出依靠实时 `chat` 事件。由于事件不会回放，Adapter 同时使用
OpenClaw 官方推荐的运行对账语义：发送前读取一次有界 `chat.history` 基线，发送后调用
`agent.wait`；若运行已完成但终态事件缺失，再读取最新 assistant 消息并与基线比较，恢复唯一的
最终回复。实时事件存在时仍保持流式；对账只防止连接或版本边界上的事件间隙导致永久等待。

官方 Gateway npm package 当前处于首批 release train，项目精确固定已测试版本，不跟随浮动 tag。
升级客户端或 OpenClaw Gateway 时必须运行 fake contract、两轮真实 smoke 和企业微信验收。

## 验证

- fake Gateway 覆盖流式、两轮恢复、取消、本地图片 attachment 和终态事件缺失对账；
- 本机现有 OpenClaw Gateway 使用既有 `zai/glm-5.2` 配置完成两轮真实调用；首轮 8.2 秒、续接轮
  6.4 秒，输出与预期严格一致；
- 企业微信授权私聊完成首轮文本、同会话恢复和真实图片输入；官方 WeCom SDK 下载/解密、临时
  物化、OpenClaw attachment、GLM 回复、可变 Bot 消息和 finally 清理均通过；
- 授权群聊 `@Bot` 完成 group-only ACL、独立 session、流式回复与最终投递；
- Gateway 客户端凭据仅由操作系统凭据存储注入进程，没有写入 `.env`、Git、测试输出或普通日志；
- 整个验证未使用 Codex 身份或设备授权。

## 后果

- OpenClaw 成为第三种真实 Kernel 接入路径，也是第一个非 ACP、非 Codex 专用 Adapter；
- OpenClaw 自有工具仍由 OpenClaw 管理，当前不把 Gateway 的 `RuntimeTool` catalog 重复注入；
- 丢失实时事件时可能退化为一次最终消息，但不会让已完成的 Agent run 在 Channel 中等待至超时；
- 远端 OpenClaw、设备配对和审批事件映射保留为单独的安全设计，不扩大首版 loopback 边界。
