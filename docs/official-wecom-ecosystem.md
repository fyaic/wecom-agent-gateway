# 企业微信官方与周边生态调研

调研快照：2026-08-20；Kernel 协议补充于 2026-08-24；卡片复核于 2026-08-25。版本和 commit 是为了让结论可复核，
不表示项目永久固定在这些版本。

## 官方能力地图

| 项目                                                                            | 快照                             | 已确认能力                                                                                                                      | 在本项目中的定位                                  |
| ------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [`@wecom/aibot-node-sdk`](https://github.com/WecomTeam/aibot-node-sdk)          | npm `1.0.7`；仓库 main `80615b9` | WebSocket 认证、心跳、指数退避重连；文本/图片/混合/语音/文件/视频消息；流式与卡片回复；主动 `sendMessage`；媒体上传、下载和解密 | 首选且唯一的 Bot WebSocket 协议实现               |
| [`wecom-openclaw-plugin`](https://github.com/WecomTeam/wecom-openclaw-plugin)   | `2026.8.17`；main `3b1cbe3`      | Bot WebSocket/Webhook、单聊/群聊、流式回复、主动推送、富媒体、ACL、多账号、动态 Agent 路由、会话、`wecom-cli` 工具              | 产品级语义与异常处理参考，不作为运行时依赖        |
| [`wecom-cli`](https://github.com/WecomTeam/wecom-cli)                           | npm `1.1.0`；main `59604ae`      | 通讯录、消息、文档、表格、微盘、日程、会议、待办、邮件等办公业务工具                                                            | Agent 工具层；不负责 IM 入站                      |
| [`wecom-unified`](https://github.com/WecomTeam/wecom-unified)                   | main `33aaa71`                   | 面向 WorkBuddy、CodeBuddy、MiniMax Code、Kimi Work、Codex、Cursor 的统一 Skill 分发                                             | 工具说明/Skill 生态参考，不是常驻 Channel runtime |
| [`wecom-aibot-python-sdk`](https://github.com/WecomTeam/wecom-aibot-python-sdk) | main `6bcb59a`                   | Node SDK 的 Python 语义对应实现                                                                                                 | 跨语言行为参考；首版仍选 Node                     |

## 对官方 OpenClaw 插件的代码核验

此前只把它视作普通 OpenClaw Channel，调研不完整。进一步核验源码后确认它已经覆盖本项目目标架构的大部分 WeCom 侧难点：

- `src/monitor.ts` 使用官方 `WSClient`，监听连接、鉴权、断连、重连、消息和事件，并负责 ACL、session 记录与 runtime dispatch。
- `src/message-sender.ts` 对普通消息使用 `replyStream`；事件 frame 没有有效 `req_id` 时改用 `sendMessage`；流式窗口过期也可主动推送最终结果。
- `src/media-handler.ts` 使用 SDK `downloadFile` 完成带 AES key 的媒体下载。
- `src/dynamic-routing.ts` 在没有显式 binding 时动态选择 Agent，并隔离 session key。
- `src/cli/tool.ts` 把 `wecom-cli` 作为受限工具执行，按 Bot 注入独立配置目录，限制输出、超时和参数，避免 Agent 绕过凭据隔离直接调用 shell。

这些实现证明“企业微信 Bot ↔ 通用 Agent runtime”在官方生态里已经可行，也说明我们不应重写认证、心跳、重连或媒体密码学。它们不能直接成为本项目内核，原因是其路由、session、tool 和 reply 生命周期都绑定 OpenClaw API；本项目需要稳定的中立契约。

媒体 API 的官方边界也已核对：图片、文件和视频回调给出五分钟有效的加密 URL 与每链接独立
AES key；语音回调给出转写文本，不给原始音频 URL。`downloadFile` 负责下载和 AES 解密；
`uploadMedia` 采用 `init → chunk → finish`，单片不超过 512KB、最多 100 片，约 50MB，并返回
三天有效的 `media_id`；随后使用 `replyMedia` 或 `sendMediaMessage`。因此本项目直接调用这些
SDK 方法，不复制密码学或分片上传协议。

官方 OpenClaw 插件还暴露了两个应纳入测试的工程风险：复杂宿主污染 Axios 默认值可能影响
SDK 下载路径；同一会话中文件下载与随后文本必须保持顺序，不能让文本 turn 越过仍在物化的
文件。本项目以独立 SDK client、按会话队列和 contract tests 约束这些风险。

卡片能力的源码复核确认：SDK `1.0.7` 提供 `replyTemplateCard`、`replyStreamWithCard`、主动
`sendMessage({msgtype: "template_card"})`、`updateTemplateCard` 和独立
`event.template_card_event` 事件；支持 `text_notice`、`news_notice`、`button_interaction`、
`vote_interaction`、`multiple_interaction`。更新必须使用对应回调的 `req_id` 并在五秒内完成。
官方 OpenClaw 插件已经实现五类卡片解析、回调和更新，但其做法是从 LLM 文本提取厂商 JSON，并用
24 小时、最多 300 项的内存缓存保存卡片。本项目只复用已验证的 SDK 语义：采用通用 Presentation
契约、SQLite 持久关联和即时更新，不复制 LLM JSON 抓取或仅内存状态。

## 明确复用与明确不复用

直接复用：

- 官方 Node SDK 的 WebSocket 生命周期、消息 frame、流式回复、主动推送和媒体 API。
- 官方插件验证过的 `req_id` 有效窗口、主动推送降级、按会话串行、ACL 和 `wecom-cli` 凭据隔离思路。
- 官方 CLI 及官方 Skill 对办公 API 的封装。

不复用：

- OpenClaw runtime、session key、配置结构和插件注册 API。
- 官方插件的 Bot/Agent 双模式与身份回退。本项目只允许 Bot 身份。
- 官方插件与 OpenClaw 绑定的动态 Agent 路由；本项目只接受显式配置的确定性 Kernel 路由，不做自然语言意图判断。
- 重造 WebSocket、加密、媒体下载或企业微信业务 API 客户端。

## 尚需持续跟踪

- SDK 与插件的 changelog、消息类型新增和错误码语义。
- 主动推送的目标范围、频率限制与不同会话类型约束。
- 被动回复窗口、事件消息无 `req_id`、流中断后的可观察状态。
- 媒体尺寸、格式、临时 URL 生命周期和安全扫描。
- 官方插件中 ACL、命令授权、多账号与动态路由的边界案例。
- `wecom-unified` 新增宿主时，对通用 Agent Adapter 能力模型的启示。

每次升级官方 SDK 都必须跑 transport contract tests，并在真实沙箱补做单聊、群聊、断线重连、流式回复、主动推送与媒体矩阵。

当前 transport 已按官方插件语义处理错误码 `846608`：超过六分钟的流式 partial 不再重试，最终文本改用同一个 Bot 的 `sendMessage` 主动推送。模板卡片事件已接入 SDK 专用 listener；五秒更新窗口超时按 UX 失败记录，不重放业务决定。

## Kernel 协议补充：ACP 与 Kimi Code

企业微信官方插件证明了 WeCom 与 OpenClaw 的完整集成，但它的 runtime API 绑定 OpenClaw。为验证
本项目自己的 Kernel-neutral 边界，第二个 Kernel 采用独立于企业微信的官方
[Agent Client Protocol v1](https://agentclientprotocol.com/protocol/v1/overview)，而不是复制 OpenClaw
插件接口。

Kimi Code 官方 [`kimi acp`](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp) 以
JSON-RPC/stdin/stdout 提供 initialize、session new/load/resume、prompt、cancel、流式
`session/update`、图片输入和权限请求。项目使用官方
[`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk) 稳定 v1 入口；不使用
仍处于 draft 的 ACP v2。这样 Kimi 或其他实际支持 ACP v1 的 Agent 可复用同一 Adapter，OpenClaw 仍可
通过独立 Adapter 接入，而企业微信 Transport 和 Core 无需变化。

## Kernel 协议补充：Pi Agent

Pi 官方 [`RPC Mode`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md) 是
stdin/stdout 严格 LF JSONL 协议，适合进程隔离集成；官方
[`SDK`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md) 适合同进程 Node
嵌入。当前官方文档没有 ACP 接口，因此不能把 Pi 填入通用 ACP Adapter。

RPC 已覆盖本项目最小需要：异步 `prompt`、base64 图片、`message_update` 文本增量、完全 settled
终态、`abort`、session state 和 session file 切换。独立 Pi Adapter 已按这些官方语义实现：严格只按
LF 分帧，等待 `agent_settled`，以 `get_last_assistant_text` 补齐终态，并在有界 worker pool 内串行
切换单 worker 的 session，对未映射的阻塞式 extension UI 显式取消。当前 fake contract、本机 Pi
`0.84.2` 真实 RPC Doctor、ZAI/GLM-5.2
两轮和企业微信私聊/重启恢复均已通过。GLM-5.2 模型目录明确声明 `images=no`；Adapter 从
`get_state.model.input` 动态协商，不把协议能力误报成当前模型能力。切换到声明
`input=["text","image"]` 的自定义 `zai-vision/glm-4.6v` 后，本机真实截图识别已通过，证明 RPC
图片格式、Adapter 映射和模型视觉能力的完整本地链路。随后企业微信纯图片也完成官方 SDK
下载/解密、临时物化、Pi 视觉回复、Outbox 投递和清理的端到端真实验证。两个不同 session 的真实
RPC smoke 也已在默认 2-worker 池内重叠完成，避免跨会话全局队头阻塞。

## Kernel 协议补充：OpenClaw Gateway Client

OpenClaw 官方将外部应用边界定义为
[Gateway WebSocket + RPC](https://docs.openclaw.ai/gateway/external-apps)，并发布
[`@openclaw/gateway-client`](https://docs.openclaw.ai/gateway/protocol) 参考客户端。公共协议当前为 v4；
`chat.send` 异步返回 run ID，`chat` 事件承载流式输出，`chat.abort` 取消，`agent.wait` 确认终态，
`chat.history` 提供有界、面向展示的 transcript。官方也明确事件不回放，外部客户端升级时应固定并
验证 Gateway/Client 版本。

本项目因此不复用 OpenClaw 的企业微信 Channel 插件 API，而新增窄的 Kernel Adapter：企业微信侧
仍由官方 WeCom SDK 和本项目 Core 承担；OpenClaw 侧只使用其公共 Gateway 控制面。OpenClaw 继续
管理模型、provider 凭据、工具、工作区和 transcript。实际本机验证沿用了既有 `zai/glm-5.2`，没有
登录 Codex，也没有将模型 API Key 复制到本项目。
