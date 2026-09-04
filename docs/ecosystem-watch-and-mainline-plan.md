# 生态观察与主线执行计划

调研快照：2026-09-01。本文是后续工作的主要决策参考；`ROADMAP.md` 只保留公开的方向与检查项，
具体优先级、证据和退出条件以本文为准。项目实现变化后，应先更新本文的“当前判断”和里程碑状态，
再扩展新的产品主题。

## 一页结论

WeCom Agent Gateway 的主线定位保持不变：

> 以企业微信官方 Bot 能力为首个完整 Transport，提供忠实、耐久、可观测且与 Agent Kernel 无关的
> IM 通信中间层；Codex、ACP/Kimi、OpenClaw、Pi 只是可替换的参考 Adapter。

当前项目已经完成可工作的主干：官方 SDK WebSocket、单聊/群聊、文本与多媒体、流式/主动消息、
引用上下文、耐久 outbox、ACL、审批与交互、四类 Kernel Adapter、外部 Adapter SDK、部署和观测基线。
卡片是可选的人机交互能力，不是普通回复的默认尾部，也不是接下来继续扩展主题样式的理由。

接下来的主要差距不是“功能数量”，而是五个可验证的工程闭环：

1. **真实客户端尾项**：引用消息、原生视频、网络故障和 Linux 长时运行仍有真实矩阵未完成；审批拒绝、
   过期与进程中断已经闭环。
2. **上游兼容性**：官方社区已经暴露晚 ACK、连续消息、媒体重复、事件类型漂移、代理污染和队列溢出等风险，
   需要变成我们的固定回归矩阵。
3. **生产所有权**：当前明确支持单实例；多实例的 Bot 连接所有权、会话顺序、共享背压和 fencing 尚未设计完成。
4. **生态可接入性**：外部 Adapter SDK、独立 conformance kit、机器可读报告和 SDK-only clean-room 示例已经
   完成；下一步是用真实仓库外 Kernel 验证发布边界，并接入 Claude Code。
5. **Transport 扩展边界**：版本化 SPI、能力约束、送达层级、loopback reference 与机器 conformance 已完成；
   增加第二种生产 IM 前仍需选择真实需求和厂商验收环境。

因此，近期不以新增卡片主题、自然语言路由、Agent 推理、办公工具数量或“支持更多 IM”的宣传数字作为主线。

## 项目边界复核

| 层                         | 本项目负责                                                                         | 本项目不负责                                                |
| -------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| WeCom Transport            | 官方 SDK 生命周期、frame 归一化、媒体、流式/主动投递、厂商卡片映射、回调 fast lane | 重写鉴权/心跳/加密；真人身份；企业微信业务 API 全量封装     |
| Channel Core               | ACL、按会话顺序、背压、耐久投递、幂等、交互状态、运行控制、可观测性                | 理解用户意图；选择模型；伪造 Agent 思考或情绪               |
| Runtime Contract / Adapter | 中立消息、媒体、引用、状态、交互和取消；Kernel 协议转换                            | 把 Codex/OpenClaw/ACP/Pi 类型泄漏进 Core                    |
| Kernel / Tool              | 仅提供参考 Adapter 和少量受控工具桥                                                | Agent 的推理质量、记忆、任务规划；复制 `wecom-cli` 办公生态 |
| Presentation               | 显式能力协商下的可选卡片、原位状态和人机交互                                       | 每条普通回复自动附卡；从模型文本抓取企业微信厂商 JSON       |

这条边界也是判断社区方案是否可借鉴的过滤器：运行时功能再丰富，如果把 Channel、Agent session、模型路由、
工具和 UI 混成一个进程，就只能学习局部工程经验，不能成为本项目的核心架构。

## 近期同类与相邻项目

下表中的 star、issue 和更新时间只是 2026-08-31 的社区活跃度快照，不是质量排名。优先使用项目自己的
README、源码、release 和 issue 作为证据。

| 类别                   | 项目 / 快照                                                                                                                                                                                                                     | 值得学习                                                                                                             | 不直接复制                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 企业微信官方底座       | [`aibot-node-sdk`](https://github.com/WecomTeam/aibot-node-sdk) `1.0.7`，95 stars，23 open issues                                                                                                                               | 官方协议、流式/主动消息、媒体、事件和卡片的唯一实现基线                                                              | 私有协议重实现；把 SDK 类型扩散到 Runtime Contract                                            |
| 企业微信官方完整案例   | [`wecom-openclaw-plugin`](https://github.com/WecomTeam/wecom-openclaw-plugin) `2026.8.17`，463 stars，135 open issues                                                                                                           | 真实 WeCom 异常、群聊/session、媒体、ACL、交互卡片和主动消息案例                                                     | OpenClaw session/路由；内存 callback；模型输出卡片 JSON                                       |
| 企业微信官方工具生态   | [`wecom-cli`](https://github.com/WecomTeam/wecom-cli) `1.2.0`，2,987 stars                                                                                                                                                      | Bot 授权下的办公工具、Skill 分发和身份/权限边界                                                                      | 把工具层当作 IM 入站；用真人身份替代 Bot；依赖聊天历史拉取                                    |
| 社区 WeCom Channel     | [`sunnoy/openclaw-plugin-wecom`](https://github.com/sunnoy/openclaw-plugin-wecom)，704 stars                                                                                                                                    | 独立实现暴露出的流式 ACK、thinking 泄漏、媒体和外部会话问题                                                          | 用推理内容冒充进度；依赖非官方外部客户方案                                                    |
| Kernel 专用桥          | [`wecom-codex-bot`](https://github.com/Diluka/wecom-codex-bot)、[`clawrelay-wecom-server`](https://github.com/wxkingstar/clawrelay-wecom-server)、[`opencode-chat-channel`](https://github.com/coneycode/opencode-chat-channel) | 证明 Codex/Claude Code/OpenCode 直连 IM 的实际需求；消息批处理、PTY/App Server 接入和简单 Channel interface 可供对照 | Kernel 专用 session 进入 Channel；个别实现默认无数据库或仅用内存 TTL；未验证的 WeCom skeleton |
| 多 Kernel / 多 Channel | [`opendray`](https://github.com/Opendray/opendray) `v2.14.0`，2026-08-31 发布，58 stars                                                                                                                                         | 单一 REST+WebSocket 集成面、多个 CLI runtime、六种 Chat Channel、持久 session、审计和自定义 Bridge                   | 它是完整 Agent runtime；PTY、记忆、账号池和 Round Table 不属于本项目                          |
| Transport 套件探索     | [`theokit-gateways`](https://github.com/usetheokit/theokit-gateways)，2026-08-31 活跃，10 个平台 Adapter + 中立 Core、0 stars                                                                                                   | transport-agnostic core、Adapter conformance、每个平台明确区分“发送已接受”与“真实送达”                               | 项目很新且缺少社区验证；部分平台尚未真实验收，不能把 package 数量当作生产成熟度               |
| 成熟 IM Bridge 框架    | [`mautrix-go`](https://github.com/mautrix/go) `v0.30.0`、[`matterbridge`](https://github.com/42wim/matterbridge)                                                                                                                | Transport/状态存储拆分、房间/身份映射、桥接扩展治理和长期兼容思路                                                    | puppeting 身份模型；最低公分母式消息转发；旧项目的全部设计                                    |
| Agent 协议             | [`ACP`](https://github.com/agentclientprotocol/agent-client-protocol) schema `v1.21.0`、[`AG-UI`](https://github.com/ag-ui-protocol/ag-ui) 2026-08-27 release                                                                   | ACP 的版本/能力协商；AG-UI 的事件化运行、状态、工具和 human-in-the-loop 表达                                         | 把任一协议定为 Core 内部模型；假设所有 Kernel 都支持相同交互                                  |
| 主流 Kernel SDK        | [`Claude Agent SDK`](https://github.com/anthropics/claude-agent-sdk-typescript) `0.3.252` / Claude Code `2.1.252`                                                                                                               | 官方流式、session resume、取消、图片、工具审批和 `AskUserQuestion`；可检验第五种 Kernel 映射                         | PTY 抓屏；共享订阅凭据；把受 Commercial Terms 管理的 SDK 当作本项目 MIT 代码                  |
| IM 原生 Agent 产品     | [`Mattermost Agents`](https://github.com/mattermost/mattermost-plugin-agents) `v2.5.3`                                                                                                                                          | thread/channel 原生 UX、反馈、摘要入口、流式 benchmark 和多 provider 评估                                            | 把 Gateway 变成 IM 内的 Agent 产品或知识应用                                                  |

### 对竞品形态的判断

社区目前大致分为三种产品：

- **Kernel 专用 Bot**：上手快、功能直观，但 session、模型协议和 Channel 生命周期紧耦合；更适合验证需求，
  不适合成为通用中间层。
- **全栈 Agent Gateway**：同时管理 PTY、记忆、账号、Web UI 和多个 IM，产品面更大；与本项目在名字上接近，
  但边界不同。本项目应把“通信可靠性和可替换 Adapter”做得更窄、更可验证。
- **通用交互协议/Transport 套件**：最值得借鉴能力协商、事件 envelope、conformance test 和送达语义，
  但其抽象不能覆盖企业微信独有的五秒回调、流式窗口、主动消息限制和可变卡片。

我们的差异化不应描述成“另一个支持多个模型的聊天机器人”，而应是：**企业微信优先、Kernel 可替换、
投递耐久、事件保真、交互可恢复、边界可测试的 IM Gateway**。

## 官方社区问题给出的工程信号

截至快照日，官方和高活跃社区 issue 已经形成稳定的问题簇。这些不是要求我们复现上游实现，而是用于
设计兼容测试和故障注入：

| 问题簇              | 代表证据                                                                                                                                                                                                                                                                                                                                                                               | 本项目动作                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| ACK、重试与队列     | SDK [#27 晚于五秒的 ACK 导致媒体片重试](https://github.com/WecomTeam/aibot-node-sdk/issues/27)、[#5 回复队列溢出](https://github.com/WecomTeam/aibot-node-sdk/issues/5)                                                                                                                                                                                                                | 固定 late-ACK/重复 ACK/队列饱和测试；区分 WeCom 已接受、最终可见和 durable final                          |
| frame 与事件漂移    | SDK [#26 `msg_item`](https://github.com/WecomTeam/aibot-node-sdk/issues/26)、[#22 TemplateCardEvent 形状](https://github.com/WecomTeam/aibot-node-sdk/issues/22)、[#15 控制字符解析](https://github.com/WecomTeam/aibot-node-sdk/issues/15)                                                                                                                                            | 未知字段前向兼容；未知消息显式诊断但不创建错误 turn；升级 SDK 必跑 fixture/真实沙箱                       |
| 连续/组合消息与顺序 | 官方插件 [#166 连续消息 stalled](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/166)、[#154 文件+文本卡死](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/154)、[#165 双流死锁](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/165)                                                                                                                   | 保持同会话严格顺序和有界 admission；新增 rapid text/file/image 矩阵；没有官方关联 ID 时不启发式合并或丢弃 |
| 最终态和重复媒体    | 官方插件 [#155 thinking 不消失](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/155)、[#150 文件重复](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/150)、[#146 图片重复](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/146)                                                                                                                         | 一个 run 只有一个 durable final；状态必须显式终止；媒体以 artifact/idempotency key 去重                   |
| 群聊与会话隔离      | 官方插件 [#172 groupSessionScope](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/172)、[#171 session 初始化冲突](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/171)、[#149 群回复丢失](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/149)                                                                                                           | conversation identity 不依赖显示名；同会话单 owner；群聊和私聊分别做并发、重启与 ACL 验收                 |
| 编辑、撤回和修正    | 官方插件 [#173 消息编辑/撤回](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/173)                                                                                                                                                                                                                                                                                           | 先确认官方 frame 和不可变 ID；作为 Channel context event 设计，不把修正静默伪造成新用户消息               |
| 媒体路径和宿主污染  | 官方插件 [#169 Axios defaults 污染](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/169)、[#178 相对路径附件降级](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/178)                                                                                                                                                                                             | SDK client 隔离；artifact path/access 显式化；代理和完整性纳入部署矩阵                                    |
| Bot 身份与工具边界  | CLI [#125 非机器人身份发送](https://github.com/WecomTeam/wecom-cli/issues/125)、[#120 无法拉群历史](https://github.com/WecomTeam/wecom-cli/issues/120)、[#114 授权过期产生同名 Bot](https://github.com/WecomTeam/wecom-cli/issues/114)、[#87 暴露授权有效期](https://github.com/WecomTeam/wecom-cli/issues/87)、[#134 读写授权分叉](https://github.com/WecomTeam/wecom-cli/issues/134) | 坚持 Bot-only；`wecom-cli` 只在工具层；稳定归一授权失效、写操作不自动重试；不把历史拉取当作 Channel       |

## 后续主线里程碑

优先级规则：同一阶段未达到退出条件前，不开始后续可选产品主题。真实验收必须同时记录客户端现象、结构化日志、
Core/Outbox 状态和清理结果，不能只记录“看到了回复”。

### M3.0：官方兼容与真实客户端收口（P0）

目标：把“已实现但尚未真实证明”与社区高频故障统一成一套可重复的 WeCom conformance matrix。

交付：

- 完成私聊/群聊引用文字、引用媒体的真实 callback 与 Adapter 保真验收。
- ~~完成审批拒绝、过期、进程中断三种真实路径；确认工具零执行、卡片终态唯一、重启后无孤儿 resume。~~
  2026-09-01 已通过。
- 完成原生视频 callback；验证下载、解密、大小/MIME、Kernel capability 和清理边界，不评价模型能否理解视频。
- 新增 late ACK、重复 ACK、未知字段/消息类型、连续 text+file/image、媒体重复 frame、流最终态、代理环境的
  确定性 fixture 与故障注入。
- 建立 `upstream-compatibility.md`：记录官方 npm 版本、已知 issue、采用/规避状态和每次升级结果。

退出条件：上述自动化全绿；授权单聊与群聊各完成一次真实矩阵；无重复 final/media、无 pending/leased outbox、
无孤立 interaction；失败路径有明确、隐私安全的诊断。

### M3.1：单实例生产认证与多实例语义（P0）

目标：先把当前承诺的单实例做成可部署事实，再决定是否实现分布式运行。

交付：

- 在真实 Linux/systemd 主机完成不少于 24 小时 soak，覆盖进程重启、日志轮转、磁盘水位和健康采集。
- 完成宿主机级网络断开/恢复，而不只是在容器 network namespace 中模拟。
- ~~为单 Bot 双进程启动增加明确的 owner 冲突诊断，禁止静默双消费。~~ 2026-09-02 已完成本机
  single-active lock、崩溃回收和部署配置。
- 已由 [`ADR 0026`](adr/0026-single-bot-process-ownership.md) 固化 Multi-instance 的前置约束：account
  connection owner、conversation lease/fencing token、共享 admission/backpressure、全局顺序、
  outbox/media store、failover RTO 和 split-brain 处理；active-active 实现仍需独立分布式设计。
- 只有 ADR 与故障模型通过评审后，才决定实现 shared SQLite 不可能覆盖的分布式 store/lease。

退出条件：systemd soak 报告可复核；断网恢复不丢 durable final；双实例不会同时处理同一 callback；ADR 对
正常、崩溃、网络分区和恢复四类路径都有唯一语义。

### M3.2：Adapter 生态与协议兼容（P1）

目标：证明“Kernel-neutral”不仅是仓库内四个 Adapter 的共同接口，也能被外部实现稳定使用。

交付：

- ~~从现有 contract tests 提取可独立运行的 Adapter conformance kit，输出机器可读 capability/结果清单。~~
  2026-09-02 已完成 schema v1 JSON、隐私安全错误码和 SDK-only clean-room 认证。
- clean-room 示例已覆盖文本、流式、session、引用、图片、reply-action 幂等和取消；审批、工具、状态、输出
  媒体和 live interaction 继续要求 Kernel 专用 deterministic probe，不允许由声明冒充通过。
- Claude Code C0 已使用官方 Agent SDK `0.3.258` 完成 streaming、resume、cancel 和错误边界；C1/C2 仍需
  用户自有凭据下的真实 text/session/auth、image、approval 和 ask-user 验收。详见
  [`claude-code-adapter-evaluation.md`](claude-code-adapter-evaluation.md)。
- 再选择一个仓库外 Kernel/协议做 clean-room 接入案例，考察 ACP 稳定实现或 OpenCode；不以 star 数决定。
- 跟踪 ACP 的 negotiated `protocolVersion` 和 capability，而不是用 schema artifact 版本推断 wire compatibility。
- 写一份 AG-UI mapping note，仅评估 run/status/tool/interaction event 的转换价值，不让 AG-UI 成为 Core 依赖。

退出条件：一个外部 Adapter 只依赖发布的 SDK/contract 即通过 conformance；示例无需修改 Core；失败能力
fail closed；真实 WeCom smoke 有可公开的脱敏证据。

### M3.3：Transport 扩展模型（P1）

目标：先定义“第二种 IM 怎样不破坏企业微信已验证语义”，再选择实现对象。

交付：

- ~~编写 Transport SPI ADR：inbound envelope、conversation identity、capability negotiation、reply handle、主动投递、
  媒体 artifact、interaction callback、delivery receipt、ordering 和 backpressure。~~ 2026-09-02 已由
  Channel Transport Contract v1 与 ADR 0028 固化，Gateway 在任何副作用前执行运行时兼容检查。
- ~~用 loopback/reference Transport 跑 Core conformance，不依赖真实厂商。~~ vendor-free loopback 已通过固定
  22 项报告；测试 driver 与生产 SPI 隔离，报告不包含消息、路径、身份、回执 ID 或上游错误正文。
- ~~明确语义分级，不能把厂商 HTTP 200 当最终送达。~~ 当前固定为 Core durable intent → Transport accepted →
  vendor-specific visible/acknowledged；公共 `DeliveryReceipt` 只表达第二层。
- 能力一致性已 fail closed；下一步在有明确使用者和验收环境后评估 Bot HTTP Webhook 或第二个 IM，并为其缺失的
  可变消息、卡片、引用或主动推送定义确定性降级，不追求最低公分母。

退出条件：第二 Transport package 不引入厂商类型到 Core/Runtime Contract；相同 Core suite 通过；能力缺失有
显式结果；WeCom 回归无变化。实现第二个商业 IM 不是本阶段的强制退出条件。

### M3.4：事件保真与可选 UX（P2）

只有 M3.0–M3.2 退出后再排期：

- 研究编辑/撤回、合并转发、网页转发、群成员 @ 等官方 frame；能稳定关联原消息时再扩展 Channel event。
- 主动任务卡、群投票聚合和更多卡片主题继续作为可选 Presentation；普通回复默认不附卡。
- 对群聊显示名、欢迎语、反馈入口做 UX 优化，但不让显示名成为安全或 session identity。
- 是否增加第二个真实 IM、分布式 outbox/media store，以部署需求和 M3.1/M3.3 证据决定。

## 执行顺序与工作看板

| 顺序 | 工作包                                     | 依赖 | 预计变更面                                | 当前状态                                           |
| ---- | ------------------------------------------ | ---- | ----------------------------------------- | -------------------------------------------------- |
| 1    | M3.0-A 引用 + 审批异常真实矩阵             | 无   | 文档/验收脚本；必要时 Transport/Core 修复 | 部分完成：审批与机器验收器闭环；引用待客户端入口   |
| 2    | M3.0-B 上游兼容 fixture 与版本台账         | 无   | Transport tests、compatibility 文档       | 自动化与单聊/群聊回归完成；代理待验收              |
| 3    | M3.0-C 原生视频与连续组合消息矩阵          | A/B  | Media/Transport tests                     | 自动化与防误报验收器闭环；真实原生 callback 待验收 |
| 4    | M3.1-A Linux/systemd soak + 宿主网络故障   | M3.0 | deployment、observability、验收报告       | 待执行                                             |
| 5    | M3.1-B 多实例 ADR 与双 owner fail-fast     | M3.0 | ADR、启动/租约边界                        | single-active 闭环；active-active 暂缓             |
| 6    | M3.2 conformance kit + Claude Code Adapter | M3.0 | SDK、Adapter、tests、真实案例             | C1 smoke/失效诊断完成；成功路径待凭据              |
| 7    | M3.3 Transport SPI ADR + loopback contract | M3.1 | Contract/Core/新 Transport 测试包         | v1 SPI + 22 项 loopback 已完成                     |
| 8    | M3.4 事件和可选交互扩展                    | 前项 | 按独立 ADR                                | 暂缓                                               |

每个工作包应保持“小步提交 + 自动化证据 + 必要的真实客户端证据”。遇到上游限制时，先记录明确 capability 和
降级，不以临时 prompt、sleep、无限重试或人工观察掩盖协议缺口。

## 明确不做与触发重评条件

近期不做：

- 不在 Core 中加入 Agent 规划、记忆、模型路由或自然语言意图判断。
- 不为追求“双身份”接入真人账号，也不把 `wecom-cli` 当作收取聊天消息或群历史的通道。
- 不把卡片附在每条普通回复后，不以新增卡片样式替代传输可靠性工作。
- 不在没有稳定关联字段时合并、覆盖或丢弃用户连续消息。
- 不承诺多实例 active-active，直到 ownership/fencing ADR 和 store 选型完成。
- 不因 AG-UI、ACP 或某个 Kernel 流行就更换 Runtime Contract；只在 Adapter 边界映射并通过 capability 协商。

触发计划重评：官方 SDK/协议出现 breaking change；真实客户需要多实例 RTO；第二个 IM 有明确使用者和验收环境；
外部 Adapter 暴露 Contract 无法表达的通用语义；或生产指标证明当前 backpressure/outbox 模型不能满足目标。

## 持续观察机制

每两周或每次官方依赖升级时执行一次轻量观察：

1. 记录 `@wecom/aibot-node-sdk`、`@wecom/wecom-openclaw-plugin`、`@wecom/cli` npm 版本和仓库 commit。
2. 查看官方 SDK、插件和 CLI 新增 issue/release，只按 ACK/顺序/媒体/事件/身份/权限/会话类别归档。
3. 查看 ACP、AG-UI 的 protocol/capability 变化；artifact release 不等同 wire version。
4. 查看一至两个多 Kernel/多 Channel 项目的 release，重点观察 Adapter SPI、送达语义、session ownership 和运维，
   不跟随 UI、记忆或模型编排范围。
5. 只有当新信号改变优先级、Contract 或验收矩阵时才更新本文；不维护泛化的项目大全。

相关内部基线：[`architecture.md`](architecture.md)、[`status.md`](status.md)、
[`official-wecom-ecosystem.md`](official-wecom-ecosystem.md)、[`adapter-authoring.md`](adapter-authoring.md)、
[`deployment.md`](deployment.md) 和仓库根目录 [`ROADMAP.md`](../ROADMAP.md)。
