# 架构

## 目标边界

```text
IM 客户端
      ↕
Channel Transport v1（企业微信参考实现使用官方 SDK）
      ↕ InboundMessage / OutboundCommand
channel-core（ACL、幂等、顺序、重试、呈现、指标）
      ↕ AgentRunRequest / AgentRunEvent
Kernel Adapter
      ↕
Codex / Pi Agent / Kimi Code / OpenClaw
      ↘ tool-wecom-cli（办公业务工具）
```

三条边界必须保持独立：

1. `transport-wecom-bot` 只处理企业微信协议与消息归一化，复用官方 SDK 的认证、心跳、重连、回复、推送和媒体能力；
   其他 IM 必须通过相同的版本化 Transport SPI，而不是向 Core 注入厂商类型。
2. `channel-core` 只处理通用 Channel 编排，不引用 Codex/OpenClaw 类型。
3. 每个 Agent Kernel 通过 `AgentRuntimeAdapter` 接入；`wecom-cli` 是可注入的工具，不是消息传输层。

项目主线按优先级是：入站/出站连通与顺序、消息和引用上下文归一化、媒体生命周期、会话恢复、
背压与可靠投递、可观测性、稳定 Adapter Contract。结构化卡片只是一项可选
`structured-presentation` / `interactive-presentation` Transport capability；关闭它或换成不支持卡片的
IM Transport，不得破坏普通文本、媒体、流式回复或 Agent session。Core 也不得为了卡片从 Agent
自然语言中猜测意图或解析厂商 JSON。

## Channel Transport SPI

`ChannelTransport` 是版本化运行时边界。每个实现必须声明 `contractVersion`、稳定 ID、capabilities 以及
精确的输入/输出媒体集合；Gateway 在启动 Adapter 和开放入站前检查版本、字段和能力依赖。媒体输入依赖
下载/物化能力，媒体输出依赖上传能力，交互卡依赖结构化呈现，组合回复依赖可变流式回复。声明矛盾会在
任何厂商连接或 Agent turn 前失败。

```text
厂商 callback/frame
      ↓ Transport 归一化
InboundMessage / ChannelFeedbackEvent / ChannelEnterChatEvent
      ↓ Core：ACL、顺序、背压、session、durable intent
OutboundCommand
      ↓ Transport 厂商投递
DeliveryReceipt（仅 accepted，不代表 visible/read）
```

`@fyaic/transport-loopback` 不导入企业微信或 Kernel 类型，通过独立 22 项 conformance 证明单聊/群聊、
引用、非语义事件、媒体、流式/主动回复和交互投影都能只使用公共契约。测试注入面
`TransportConformanceDriver` 不属于生产 SPI。机器报告位于
[`evidence/transport-conformance-loopback.json`](evidence/transport-conformance-loopback.json)，详细接入规则见
[`transport-authoring.md`](transport-authoring.md) 与
[`ADR 0028`](adr/0028-versioned-transport-spi.md)。

送达严格分层：SQLite/Outbox 表示 Core 已耐久接受意图，`deliver()` 回执表示 Transport 接受命令，厂商或
客户端是否可见、是否已读仍需独立真实证据。公共契约不会把 HTTP 200 或 SDK 回调统一命名为“已送达”。

引用/回复消息使用独立 `message.quote.parts`，不会塞入 WeCom metadata。Transport 归一化并按与当前
消息相同的临时目录、总大小和清理规则物化引用媒体；Core 要求 Adapter 声明 `quoted-context`，否则
进入 Kernel 前拒绝，避免静默丢失被引用前文。各 Adapter 最后通过 `agentInputParts()` 在 Kernel 边界
加入明确分隔，企业微信私有 quote 结构不会扩散到上游协议。

媒体的 Runtime 类型表达解密后内容的语义模态，不等同于厂商 wire frame 名称。企业微信桌面端可能把
MP4 作为 `msgtype=file` 上传；Transport 只在受保护下载后以 magic bytes/扩展名检测到明确 MIME 时将
中性 part 提升为 `video`、`audio` 或 `image`，同时保留 `metadata.msgtype=file` 供诊断。未知二进制仍为
`file`，原始 URL、AES key 和本地路径不会持久化。

普通流式回复使用官方 `replyStreamNonBlocking`：有同 `req_id` ack 未完成时只跳过旧 partial，最终帧
永不跳过，且仍由 durable outbox 重试。组合卡流只能在第一帧选定；流已按 plain 开始后才出现的卡片
改走独立主动消息。回复 feedback 是独立 `ChannelFeedbackEvent`，只供观测/产品策略订阅，默认不创建
Agent turn。`enter_chat` 欢迎语同样由 Transport 在五秒窗口内静态回复，不经过 Core 路由或 Kernel。

## 通用工具边界

`RuntimeTool` 是 Kernel-neutral 契约，只包含工具 schema、副作用等级、审批要求和执行函数。
`channel-core` 不读工具参数、不判断工具意图，也不把办公业务规则写进消息链路。Kernel adapter
把它转换成原生工具协议；Codex 参考实现按官方
[App Server](https://learn.chatgpt.com/docs/app-server) 的实验性 `dynamicTools` / `item/tool/call`
流程转换，并只在启用工具时协商 `experimentalApi`。

默认生产工具只有只读 `wecom_contact_search`。它固定调用 `wecom-cli contact users search`，
模型只提供经过二次校验的 JSON 业务参数。第一个写工具 `wecom_todo_create` 只创建单条待办，
固定映射 `wecom-cli todo create`，返回内容会移除待办/成员内部 ID；它由独立开关控制，且声明
`write + approval=required`。不存在接受自由命令路径或 argv 的万能工具。

```text
Kernel 原生 tool call
        ↓ Kernel adapter
RuntimeTool(name/schema/effect/approval)
        ↓ 精确 registry lookup + 参数校验
tool-wecom-cli 固定命令映射
        ↓ execFile（无 shell）
企业微信办公业务 API
```

工具执行默认 60 秒超时、256KiB 输出上限。失败向 Kernel 返回无敏感信息的通用结果，详细原因
只走本地脱敏错误回调。Codex 动态工具当前是实验协议，所以 wire type 不进入 core；新增 Kernel
只复用 `RuntimeTool` 契约。

每次已注册工具调用输出 `started/succeeded/failed` 生命周期事件，只含稳定工具名、副作用等级和
耗时；不记录调用参数、返回正文、session/call ID 或企业微信内部标识。

Codex App Server 会把动态工具写进 thread rollout。Adapter 因此计算工具 catalog 的稳定哈希作为
`sessionCompatibilityId`；Gateway 仍用稳定的 adapter `id` 做路由和指标，但用 compatibility ID
隔离 session 映射。工具 schema 变化后首次消息会创建新 thread，不会错误恢复旧 catalog。

## 审批控制面

审批是 Gateway 的通用控制面，不属于 Agent 推理：

```text
Kernel tool call
      ↓ requestApproval（只含工具名/副作用/安全摘要）
Gateway SQLite pending → 独立 Bot 控制消息显示 /approve CODE 或 /deny CODE
      ↑ 同 account + conversation + sender，且通过 ACL
精确控制命令绕过 Agent 会话队列
      ↓
approved → adapter 执行工具
denied / expired / interrupted → adapter 不执行
```

支持结构化交互的 Transport 会发送独立“批准/拒绝”按钮卡片；初始卡片经 Outbox 耐久投递，回调继续
经过 ACL、入站幂等以及 SQLite 中 account/conversation/sender/expiry 绑定，并在官方五秒窗口内原位
更新结果。业务决定先持久化，原位更新是不可重试的 UX 操作。Transport 不支持卡片时，审批码不进入
Agent 的可变流式回复：原回复只显示等待状态，独立 Bot 主动消息保持可复制，直到客户端历史消息自然
保留。Transport 不支持 `proactive-message` 时审批 fail closed。Gateway 不把
“可以”“同意”等自然语言解释成审批。控制命令必须是单一文本 part，并精确匹配
`/approve CODE` 或 `/deny CODE`。它绕过 Agent 队列是为了解开正在等待的同会话 turn，不绕过
ACL、入站幂等或发送者绑定。重复、跨会话、跨发送者和过期命令统一拒绝。
同一 Agent run 如果并发发起多个写工具调用，Gateway 会串行呈现审批，前一个产生决定后才展示
下一个，避免同一条可变 Bot 消息覆盖仍有效的审批码。

Gateway 审批策略默认上限五分钟，Kernel adapter 可声明更短的协议等待上限，实际取较短值；Codex
App Server 当前为 90 秒。停机和启动都会把遗留 `pending` 标成 `interrupted`；Kernel turn 如果先
结束，也立即中断属于该 run 的审批。进程重启后不会恢复并补执行旧副作用。SQLite 保存状态和经过
校验的具体审批摘要用于审计；prompt 不含原始 JSON、内部 ID、凭据或工具结果，生命周期日志连摘要
也不记录。存储异常 fail closed，并保证内存中的等待不会永久悬挂。

## 结构化卡片边界

Core 只认识通用 `Presentation`：notice、article、actions、choice、form。WeCom Transport 负责映射为
官方五种 template card、约束长度/数量/唯一 ID、校验 HTTPS 链接和可选 hostname allowlist，并把
`template_card_event` 归一化为通用交互。卡片不是 Agent 推理接口；不会扫描 Agent 文本中的 JSON，
也不会把企业微信私有结构扩散到 Adapter。

当 Adapter 声明 `status-events`，且 Transport 同时支持 `structured-presentation` 与
显式 status/emoji 只进入 250ms 合并的可变文字。官方 SDK 虽支持 `reply-with-presentation`，但真实
macOS 客户端不会可靠显示首帧组合卡；重复附带卡片又违反同一流式消息只能回复一次 `template_card`
的契约。因此 Core 不用组合流承载运行控制，也不根据耗时、工具名或文本猜测“思考中”。最终正文关闭
同一 stream；完成时才得知的快捷操作仍走独立 proactive card。

完整的 Agent 交互卡架构、SDK/CLI 分工、状态机和里程碑见
[`interaction-cards.md`](interaction-cards.md)。Core 的 Interaction Broker 已实现五秒 callback fast
lane、TTL、发送者/会话绑定和 durable deferred resume；Kernel continuation 不进入 WeCom
Transport。Pi 与 Codex App Server 已接入上游真实 ask-user；ACP v1 只有 permission request，OpenClaw
Gateway v4 也没有导出通用 elicitation response，因此不会以合成 Prompt 冒充缺失协议。

长任务控制属于 Core，不属于 Kernel 推理。Adapter 声明 `cancel` 且已有活动 session 时，Core 在阈值
后发送一次独立 `run_control_*` 主动卡。SQLite 单独保存
account/conversation/sender/TTL 和首答状态；点击后先在企业微信回调窗口内原位确认，再调用该 session
的原生 `cancel()`。控制动作不进入 Agent 文本队列、不创建新 turn，也不复用 ask-user、审批或最终回复
action 的 namespace。任务自然结束后无法在没有 callback 的情况下主动更新旧卡；因此卡面明确限定为
“本轮”，旧卡第一次点击只会原位显示任务已结束，绝不取消后续 run。

## Gateway Core 与 Adapter Host

Gateway 是项目核心，但不是一个只转发字符串的薄壳。它同时是中立的 Adapter Host：

- 先启动 Adapter，全部 ready 后才开放 transport 入站；
- 关闭时先停止入站、排空已接收任务，再释放 Adapter；
- 为每个 Adapter 统一托管 session、cancel、approval、capability、超时、背压和指标边界；
- Adapter 以独立 package 实现 Kernel SDK/RPC 的小范围定制，core 不 import vendor 类型。

每个 Adapter 必须声明 `contractVersion`。当前公共边界为 v1；Gateway 在启动任何进程或开放入站前
校验版本和 Adapter ID 唯一性，不兼容实现直接拒绝。`contractVersion` 描述 Core/Adapter 事件语义，
`sessionCompatibilityId` 描述该 Adapter 的持久 session 是否可恢复，两者不能互相替代。

`@fyaic/wecom-adapter-sdk` 将这条边界开放给仓库外的 Kernel 集成。显式选择 `external` 后，Host
异步装载一个受信模块 factory，只传入版本、有界 Adapter JSON、可选 RuntimeTools 和受控诊断回调；
返回值仍执行同一运行时兼容检查。SDK 不传 Transport、Bot Secret、ACL、Store 或 Outbox。由于模块
与 Gateway 同进程，它是扩展接口而非安全沙箱；不可信 Kernel 必须通过 ACP 子进程或其他隔离 Host。

Adapter 可以常驻 Kernel 进程、复用连接和恢复 opaque session，这是底层链路能力。它不能
通过虚假对话做预热，不能添加影响行为的提示词，也不能替 Agent 判断用户意图。Codex 的
参考实现使用官方 [Codex App Server](https://learn.chatgpt.com/docs/app-server)：Gateway 启动时
只启动一个常驻 `codex app-server --stdio` 子进程，完成一次 `initialize/initialized`，随后按会话
执行 `thread/start` 或 `thread/resume`、`turn/start`，并把 JSONL 事件忠实映射成通用 runtime
事件。启动过程不创建 thread、不发送消息，也不产生虚假 turn。

App Server 的原生 `item/tool/requestUserInput` 保持同一 turn 等待：Adapter 将问题映射为 Runtime-neutral
单选、表单或限定文本交互，Gateway 持久化后把结果从 live-resume fast lane 返回原 JSON-RPC request
ID。多步问题可以逐步发出下一条 interaction，但不能转成新用户消息；秘密输入不经过 IM。

App Server adapter 默认使用一个 ChatGPT 登录兼容、关闭 Responses WebSocket 的独立 provider。
原因是内置 `openai` provider 不允许覆盖；当前网络下它会在首轮经历 5 次 WebSocket 超时后才回退
HTTP/SSE，造成约两分钟延迟。HTTP-only provider 只改变 Codex 与服务端的传输选择，不改模型、
提示、工具、推理或会话语义；可配置恢复内置 WebSocket provider。

Codex 只是首个测试和联调案例，不是产品内核。`channel-core` 不解释用户意图，不改写输入、
不注入语义提示词，不决定模型/推理/工具，也不伪造 Agent 的思考或情绪。Kernel 的进程常驻、
缓存和启动性能属于各自 adapter，但不得用预热对话污染真实 session。

应用入口通过 Adapter Registry 显式选择 `codex`、`kimi`、任意 `acp` 可执行程序、`openclaw`、`pi`
或受信 `external` 模块。external 模块路径和自有配置由部署声明，不需要修改 Registry。当前坚持一个
Gateway 进程只托管一个确定性 Kernel；这是部署选择，不是自然语言路由。Session 使用
`sessionCompatibilityId` 分区，因此切换 Kernel 不会误恢复另一实现的会话。

通用 `adapter-acp` 使用官方稳定 ACP v1 SDK，以受管子进程承载 Kernel：

```text
Gateway AgentRunRequest
      ↓
ACP initialize → session/new 或 session/load → session/prompt
      ↑ session/update（文本增量、工具状态）
      ↓ session/cancel / session/request_permission
Kimi Code 或其他 ACP v1 Agent
```

Adapter 根据 `initialize` 响应协商 session 恢复与图片/音频输入能力；不支持的模态明确失败，不做
文本占位或静默丢弃。Kimi Code 当前声明图片输入、session load 和 cancel，不声明音频输入。ACP
Agent 自有工具触发的 permission request 复用 Gateway `requestApproval`，并保守声明为写操作；ACP
v1 未提供通用 client-tool 注入面，因此现有 `RuntimeTool` catalog 仍只由支持该能力的 Adapter 暴露。

ACP 子进程只接收显式环境白名单和 Kimi/Moonshot 专用配置；企业微信 Bot 凭据、数据库路径及其他
Gateway 配置不会继承。Codex 和 ACP Adapter 必须通过同一份 runtime-neutral 文本/流式/session
恢复 contract testkit，特定 wire protocol 另由各 Adapter 自己测试。

`adapter-openclaw` 不启动或内嵌 OpenClaw，而是用官方 Gateway Client 连接 loopback WebSocket：

```text
Gateway AgentRunRequest
      ↓ chat.send + attachments
OpenClaw Gateway → 已配置 Agent / 模型 / 工具
      ↑ chat 流式事件
      ↕ agent.wait + chat.history 终态对账 / chat.abort
```

OpenClaw 自己拥有模型选择、provider 凭据、工具与 transcript；Adapter 不要求 Codex 登录，也不读取
GLM 等模型 API Key。实时事件不会回放，因此 Adapter 在保持正常流式的同时，用 `agent.wait` 和发送
前后的有界 history 差异恢复遗漏的最终回复。该逻辑只补传输终态，不生成或解释 Agent 内容。

`adapter-pi` 启动官方 `pi --mode rpc` 子进程，严格按 LF 而非通用 line reader 解析 JSONL：

```text
Gateway AgentRunRequest
      ↓ new_session / switch_session → prompt(text + base64 images)
Pi RPC process → 已配置 provider / 模型 / 工具
      ↑ message_update.text_delta / agent_settled
      ↕ get_state / get_last_assistant_text / abort
```

每个 Pi RPC 进程只有一个当前 session。Adapter 因此使用有上限的长期 worker pool，默认
`PI_MAX_WORKERS=2`：每个 worker 内仍串行切换 session file；同一个 opaque session 由 keyed lock
保证绝不并发，不同 session 可以租用不同 worker 并行。进程数不会随会话数量增长，也不伪造一个
进程内的并发语义。session handle 对 Core 不透明，恢复前必须落在启动时推断或显式配置的 session
root 内。Pi 自有 extension UI dialog 不是 Gateway 写工具审批。原生 `select/confirm/input/editor`
已映射为 Runtime-neutral `interaction-requested`：选择/确认使用企业微信卡片，input/editor 使用同范围
下一条纯文本，结果通过 native `extension_ui_response` 恢复仍在等待的同一个 tool call。live resume
是控制响应，会绕过语义 turn 队列以避免原 run 与恢复互相等待；未映射、并发或自带 timeout 的 dialog
显式取消。

Pi 的 provider 凭据、模型、工具和 transcript 仍由 Pi 管理。子进程仅接收进程基础环境及
`PI_AGENT_ENV_ALLOWLIST` 明确列名的变量，绝不继承企业微信 Bot secret 或 Gateway 数据库路径。
部分 OpenAI-compatible provider 会把私有 `<think>` 协议哨兵混入 Pi assistant text；清洗只发生在
Pi Adapter，且只在检测到该哨兵时生效。Core/Transport 不解析 Agent 文本，也不把 provider 规则扩散到
公共 Runtime Contract。

## 可变消息生命周期

企业微信 Bot 的回复可以持续修改。Channel 用同一条消息表达一次 run：

```text
中性接收回执 → Agent 显式状态/emoji → 合并后的文本增量 → 最终正文
```

- 中性回执只说明 Channel 已接收，不声称 Agent 正在思考。
- `thinking`、`tool-running`、情绪和 emoji 只在 Agent 发出 `status` 事件后呈现。
- 默认每 250ms 合并一次文本增量；最终事件立即完成同一消息。
- Channel 不展示思维链，只转发 Agent 主动提供、允许面向用户展示的状态。

Transport 与 Kernel 分别声明 capability；后续能力启用必须取二者交集。例如 Kernel 支持
`status-events` 且 Transport 支持 `stream-reply-update` 时启用动态状态；不支持时退化为中性
回执和最终消息，不改变 Agent 语义。

粗粒度 capability 之外，Transport 与 Adapter 还分别声明精确的 `inputModalities` 和
`outputModalities`。Core 在媒体物化后、调用 Kernel 前检查输入交集；在接受 `media-output` 和调用
Transport 前检查输出交集。当前 WeCom 输入集合为 image/video/file，输出集合为
image/audio/video/file；语音回调只有官方转写文本，因此不虚报原始 audio 输入。Codex App Server
输入为 image/audio，OpenClaw 为 image/audio/video/file，Pi 按当前模型动态声明 image 或空集合。
不支持的类型明确失败并清理临时媒体，不改写成 Prompt 或占位文本。这里的类型是受保护物化后的语义
类型；原始厂商 frame 类型仍可在脱敏 metadata 中区分，因此桌面 MP4 的语义提升不等于宣称已捕获原生
`msgtype=video` callback。

## 当前 M0 数据流

1. 官方 SDK 通过 WebSocket 收到 frame。
2. transport 归一化为 `InboundMessage`，只保留回复所需的 `req_id`，不把 SDK frame 泄漏给 runtime。
3. core 按 `accountId + conversationId` 串行处理并按 `accountId + messageId` 去重。
4. router 选择 runtime adapter，store 恢复对应 session。
5. runtime 输出通用状态和流式事件，core 投影成一条可修改消息并合并高频增量。
6. core 在调用 transport 前把命令写入 SQLite outbox；媒体先完成 spool artifact 化，同一文本 stream 尚未发送的旧版本由新版本替代。
7. 当前进程立即认领新命令，后台 worker 认领到期/过期租约；成功写 journal，失败按指数退避重试，达到上限进入死信。

## 入站媒体生命周期

```text
企业微信五分钟临时 URL + AES key
        ↓ 官方 SDK downloadFile（下载并解密）
transport 私有目录 0700 / 文件 0600
        ↓ runtime-neutral path + MIME + size
Kernel adapter 原生多模态输入
        ↓ run 成功或失败
finally 删除整次消息的临时目录
```

URL、AES key 和临时路径都属于一次运行的传输材料：不会进入 Kernel session，不会写入 SQLite，
也不会出现在普通日志。默认整条消息累计上限为 50MB；文件名只取 basename 并添加稳定序号，
避免目录穿越和同名覆盖。Codex 参考 adapter 将图片和音频分别映射为 App Server 的
`localImage`/`localAudio`，不会把图片先描述成文字，也不会为附件注入占位 Prompt。

官方语音回调当前只提供企业微信转写文本，没有原始语音下载 URL，因此 transport 忠实传递
转写结果；原始音频能力不作虚假声明。视频和普通文件可以物化，但 Codex App Server 当前没有
对应原生输入类型，Codex adapter 会明确拒绝；OpenClaw 可以接收二进制附件，附件内容能否进一步
解析取决于其已配置工具。真实 MP4 验收中企业微信桌面端把视频作为普通 file 回调，Gateway 完成
下载、物化和交付，Agent 随后忠实报告缺少视频解析工具；该限制不属于 Channel 传输层。

## Agent 输出媒体生命周期

Agent 只有显式发出 runtime-neutral `media-output` 事件时才会触发外发。Gateway 同时检查 Kernel
的 `multimodal-output` 与 transport 的 `media-upload/multimodal-output` capability，并限制每次
run 的附件数量。WeCom transport 对真实路径执行 `realpath`，只有位于
`WECOM_MEDIA_OUTPUT_ROOTS` 明确目录内的普通文件才允许读取；空配置默认关闭输出媒体。

通过检查后，transport 调用官方 SDK `uploadMedia`，再以同一 Bot 身份调用 `sendMediaMessage`。
因为文本可变回复已经使用收到消息的 `req_id`，附件作为紧随最终文本的 Bot 主动消息发送，避免
同时争用一条被动回复。Agent 原文件先从 `WECOM_MEDIA_OUTPUT_ROOTS` 允许目录复制到 Gateway
控制的耐久 spool；SQLite 只保存随机 artifact 引用、类型、名称、大小和 SHA-256，不保存 Agent
工作区路径。发送时 spool 再物化受控路径，spool 与 transport 都校验大小/哈希，随后调用官方
`uploadMedia` 和 `sendMediaMessage`。

Spool 根目录为 `0700`、artifact 文件为 `0600`，单文件默认 50MB、总配额默认 500MB。发送成功
或进入死信后删除；重试期间保留。启动时 store 列出 pending/leased 的活跃 artifact，spool 保留
它们并删除崩溃遗留的 staging/无引用 artifact。原文件在 stage 后被修改或删除，不影响恢复发送。

## Gateway 原生主动消息

Agent 或本地自动化不应为了主动发消息读取 Bot Secret、内部会话 ID 或直接写 SQLite。显式启用的本地
控制面只监听权限为 `0600` 的 Unix socket，接受目标别名和文本/媒体：

```text
Agent / scheduler → local control client → 0600 Unix socket
                                      ↓ alias → scoped allowlist target
Gateway Core → SQLite Outbox → WeCom Transport → official SDK proactive push
```

唯一 scoped 私聊和群聊自动映射为 `direct` / `group`；多目标别名在私有配置中声明，并在启动前确认
目标仍属于对应分域 allowlist。响应不包含 account/conversation/outbox ID。文本和媒体调用 Core 的
公共主动发送 API，因此与入站回复共用同会话投递序列、at-least-once、重试和死信；媒体还共用安全
根目录、spool 和完整性检查。控制面不决定何时发送，也不解释 Agent 内容。

## 运维观测边界

Core 的 `operationalSnapshot()` 只输出运行状态、Transport/Adapter/Store 健康布尔值、当前工作数量和
Outbox 聚合。可选本地观测服务器在 loopback 暴露 `/livez`、`/readyz`、`/metrics`；Prometheus label
只使用代码定义的有限 phase/type/effect/component/operation。Adapter ID、tool name、错误正文、用户、
会话、消息、Prompt 和模型输出均不进入指标。观测服务不提供消息发送、配置修改或远程管理能力。

## 持久化投递 Outbox

应用入口使用 `SqliteGatewayStore` 持久化入站幂等键、runtime session、outbox 与最终投递
journal；`MemoryGatewayStore` 只用于确定性测试。文本 `reply/proactive` 与 artifact 化后的
`proactive-media` 共用状态机：

```text
pending → leased → delivered
    ↑        ↓
    └─ retry ┘
             └→ dead
pending ──同 stream 新版本──→ superseded
```

- 发送前提交 `pending`，因此进程在网络调用前崩溃时，新进程仍能恢复。
- 每次认领持有 30 秒默认租约；进程崩溃后，其他 owner 只在租约过期后接管。
- 失败按 1s、2s、4s……指数退避，默认最多 5 次、单次上限 30s，随后死信。
- 同一可变回复只有尚处于 `pending` 的旧状态会被新状态替代，避免恢复后补发过时 partial；已在发送中的命令不做危险撤销。
- 投递按 `accountId + conversationId` 串行，保持单会话顺序；不同会话并发，历史积压不会造成全局队头阻塞。
- 投递事件只输出命令类型、阶段和尝试次数，不输出消息、会话或目标 ID。

应用启动还在 Store、Kernel 和官方 SDK 之前获取本机 Bot owner lock。同一 Bot 的第二进程快速失败，
避免两个 WebSocket consumer 各自维护会话顺序。它与 Outbox record lease 是两个层次：前者保护连接
进程，后者保护单条 durable delivery；两者都不构成跨主机 fencing 或 active-active。详见
[`ADR 0026`](adr/0026-single-bot-process-ownership.md)。

这是 **at-least-once**，不是 exactly-once：远端已接受、进程却在本地完成事务前崩溃时，租约
过期后可能再次发送。下游可用稳定 stream/request 语义做幂等或更新；共享式多实例背压和图形化
死信审批界面仍属于后续可靠性工作。

## 有界接入与运行并发

入站先经过 fail-closed ACL，再申请容量，最后才写入幂等存储和进入 Agent 队列。默认边界：

- 全 Gateway 最多 100 条 active/queued 入站；
- 同一 `accountId + conversationId` 最多 10 条 active/queued 入站；
- 最多 8 个不同会话同时执行 Agent run；同一会话仍严格串行。

超过前两项的消息在持久化和创建 Agent turn 之前拒绝。事件只包含 `global-limit` 或
`conversation-limit`、会话类型、当前待处理数和 active run 数，不含消息/会话/发送者 ID。
过载路径当前不自动回复“繁忙”，避免攻击流量把入站过载放大成 Outbox/网络出站洪峰；部署侧应
对 `gateway_backpressure` 告警，再按实际容量调整三个 `GATEWAY_MAX_*` 参数。

## 死信运维边界

`outbox:status` 只显示五种状态的聚合数量。显式重排只允许 `reply(final=true)` 和 `proactive`
文本，排除过时 partial 和 artifact 已清理的媒体；每次默认 10、硬上限 100，并要求
`--confirm-requeue-terminal-text`。重排只是把命令恢复为 pending，仍由正常租约 worker 发送，原
死信 journal 保留审计。由于主动文本可能重复，任何重排都属于操作员明确授权的外部副作用。

## 身份与安全

- 外部可见身份始终是企业微信 Bot。
- 不使用真人账号补发、不做 Bot/Agent 双身份回退。
- Bot secret、Codex 凭据和 `wecom-cli` 配置目录不进入消息对象、日志或数据库正文。
- 当前消息与引用消息中的临时媒体 URL、AES key 和本地路径在 SQLite 边界统一剥离；只保留中立内容与安全元数据。
- Feedback、enter-chat welcome 与语义消息复用同一 scoped ACL；事件不会绕过授权，也不会创建 Kernel turn。
- Adapter 子进程以最小环境启动，额外模型/代理变量只能显式 allowlist；SDK 原始消息和 stderr 默认不落日志。
- SQLite 使用显式 schema 版本和终态数据有界保留；待投递、租约中、死信及待恢复交互不参与定时清理。
- ACL、命令权限和按 Bot/会话/显式配置的确定性路由属于 core/policy 层；自然语言意图路由属于上层 Agent 系统。
- 真实入口的 sender/conversation allowlist 为空时拒绝启动；群聊 mention 门将在真实 frame 语义确认后启用，避免臆造字段导致所有群消息被误拒。

## 分层延迟指标

必须分别记录接收入站、首个 Channel 回执、排队、指定 Adapter 的 Kernel 首事件、首文本、最终完成；
不得把 Kernel 推理耗时归因于企业微信传输。当前真实测试中 Channel 首回执约 0.37–0.45 秒；
原 WebSocket 冷路径首文本约 113.7 秒，HTTP-only 冷轮首文本约 6.7 秒，同线程热轮约 2.2 秒。
HTTP-only 真实私聊首文本为 3.88 秒、端到端为 5.12 秒。这些数据用于验证 adapter 与分层指标，
不构成 Channel 对其他 Kernel 的性能承诺。真实写工具批准轮中，独立审批消息送达后 17.4 秒获批，
CLI 执行 1.4 秒，整轮 29.9 秒；审批中的人工等待必须与 Channel、Kernel 和工具执行耗时分开统计。
