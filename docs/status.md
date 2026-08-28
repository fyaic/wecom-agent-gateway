# 工作状态

更新于 2026-08-28。

## 已完成并有自动化验证

| 能力                                            | 状态                      | 证据                                                                              |
| ----------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| Runtime-neutral 核心契约                        | 完成                      | TypeScript strict typecheck                                                       |
| Runtime Contract v1 与启动期兼容检查            | 完成并自动化验证          | 真实 Adapter 必须声明 v1；错误版本和重复 ID 在启动前拒绝                          |
| Agent 状态/emoji 中立事件                       | 完成并自动化验证          | Channel 只呈现 Agent 显式状态；不注入提示、不推断情绪                             |
| 可变 Bot 消息与流式合并                         | 完成并自动化验证          | 中性即时回执、250ms 增量合并、同一消息最终化                                      |
| Channel/Kernel 分层延迟事件                     | 完成并自动化验证          | 队列、首回执、Kernel 首事件/首文本、完成/失败分别记录                             |
| Transport/Kernel capability 声明                | 完成并真实验证            | ACP initialize 与 Transport capability 共同约束流式、恢复和多模态                 |
| 精确输入/输出模态契约                           | 完成并自动化/真实验证     | Core 按 Transport/Adapter 类型集合 fail closed；图片、文件、MP4 链路通过          |
| Adapter Host 生命周期                           | 完成并自动化验证          | Adapter ready 后开放入口；停入口、排空任务后释放 Adapter                          |
| 配置驱动 Adapter Registry                       | 完成并自动化验证          | `codex` / `kimi` / 任意 ACP v1 可执行程序；Core 无厂商类型                        |
| 外部 Adapter SDK 与模板                         | 完成并自动化验证          | 可信模块动态装载、v1/shape/tool 校验；新增 Kernel 无需修改 Registry               |
| 外部 Adapter 模板 Doctor                        | 本机真实验证              | 通过部署入口动态加载模板；普通 10/10、live health 11/11                           |
| 通用 ACP v1 Adapter                             | 完成并真实验证            | stdio、协商、流式/load/cancel/图片真实通过；permission 自动化通过                 |
| Codex/ACP 共享 Runtime Contract                 | 完成并自动化验证          | 两个 Adapter 共用文本、流式、首轮 session 与恢复 testkit                          |
| Kimi Code ACP Adapter                           | 完成并真实验证            | 本机真实两轮及企业微信文本、同会话图片均通过                                      |
| OpenClaw Gateway WebSocket Adapter              | 完成并本机真实验证        | 官方客户端、流式/恢复/取消/图片契约；GLM-5.2 两轮真实通过                         |
| OpenClaw 终态事件对账                           | 完成并自动化/真实验证     | `agent.wait + chat.history` 恢复缺失终态，不改写 Agent 内容                       |
| Pi 官方 JSONL RPC Adapter                       | 完成并真实验证            | 严格 LF、文本流式/恢复/取消、session root、UI fail-closed；真实私聊通过           |
| Pi CLI 与真实 RPC Doctor                        | 本机真实验证              | Pi `0.84.2`；启动/get_state/health/停止通过，Doctor 9/9                           |
| Pi 模型输入能力动态协商                         | 完成并自动化/真实验证     | GLM-5.2 动态关闭图片；GLM-4.6V 动态开启并完成真实截图识别                         |
| Pi 有界 worker pool                             | 完成并本机真实验证        | 默认 2 worker；同 session 串行、不同 session 并行；真实并发与受管重启通过         |
| 部署前 Doctor 与 checked start                  | 完成并自动化验证          | Node、凭据、ACL、权限、存储、可执行文件/Gateway 连接与 live health                |
| 聚合 Operational Snapshot                       | 完成并自动化验证          | 运行/组件/工作/Outbox 健康；无正文、用户/会话/内部 ID                             |
| loopback 健康与 Prometheus 指标                 | 完成并自动化验证          | livez/readyz/metrics、超时、枚举 label、拒绝非 loopback bind                      |
| Linux/systemd 与容器基线                        | 完成并自动化验证          | 专用用户、私有 env、非 root/read-only/cap-drop、内部 healthcheck                  |
| macOS OpenClaw 受管单实例                       | 完成并本机真实验证        | LaunchAgent、钥匙串进程注入、RunAtLoad/KeepAlive、受管重启与重新鉴权              |
| macOS Pi 受管单实例                             | 完成并本机真实验证        | LaunchAgent、Pi 私有 auth、互斥 plist；受管重启后 ready 并重新鉴权                |
| Fake transport → core → fake runtime → 流式回复 | 完成                      | `packages/channel-core/test/gateway.test.ts`                                      |
| 入站消息去重                                    | 完成                      | 同一 `accountId + messageId` 只触发一次 runtime                                   |
| 会话恢复映射                                    | 完成                      | 第二条消息复用 fake session                                                       |
| 官方 SDK frame 归一化                           | 完成                      | `packages/transport-wecom-bot/test/transport.test.ts`                             |
| 被动流式回复与主动推送映射                      | 完成                      | fake SDK client contract test                                                     |
| Gateway 原生主动消息控制面                      | 完成并自动化验证          | 0600 Unix socket、白名单别名、无凭据 CLI、文本/媒体 Outbox                        |
| Codex SDK adapter 最小实现                      | 本机真实 SDK smoke 已通过 | 创建真实 thread，经历瞬时重连后返回预期文本；快照增量与恢复 ID 有自动化测试       |
| Codex App Server 持久 adapter                   | 完成并真实验证            | 单一常驻进程、JSONL RPC、thread 恢复、流式事件、取消和无语义启动                  |
| 入站媒体临时物化                                | 完成并自动化验证          | SDK 下载/解密、50MB 上限、`0700/0600` 权限、finally 清理                          |
| Codex 原生图片/音频输入                         | 完成，真实图片已通过      | App Server `localImage`/`localAudio`；不转成文字描述、不注入占位 Prompt           |
| 媒体敏感字段持久化边界                          | 完成并自动化验证          | SQLite 不保存临时 URL、AES key 或本地临时路径                                     |
| Agent 输出媒体通用链路                          | 完成并自动化验证          | 显式事件、capability 交集、每 run 上限、安全根目录、脱敏日志                      |
| 官方 SDK 媒体上传与主动发送                     | 完成并真实验证            | `uploadMedia` → `media_id` → `sendMediaMessage`；仅发送至授权私聊                 |
| 出站媒体耐久 Spool                              | 完成并自动化验证          | 私有复制、大小/哈希、总配额、孤儿回收；数据库无 Agent 原始路径                    |
| 媒体 Outbox 崩溃恢复                            | 完成并自动化验证          | 删除原文件后重启，SQLite + spool 恢复发送并在成功后清理                           |
| Runtime-neutral 工具注册                        | 完成并自动化验证          | schema/effect/approval 契约；core 不解释工具语义                                  |
| Codex 动态工具桥                                | 完成并真实验证            | `dynamicTools`、`item/tool/call`、超时/输出上限、通用错误脱敏                     |
| `wecom-cli` 只读联系人工具                      | 完成并真实验证            | 精确命令映射、二次参数校验、`execFile`、独立配置目录；本机真实搜索通过            |
| 持久化审批控制面                                | 完成并真实批准验证        | 精确命令、同会话/发送者绑定、幂等决定、超时与停机/重启中断                        |
| Codex 写工具审批映射                            | 完成并真实批准验证        | 仅批准后执行；拒绝/过期/中断均不调用工具函数                                      |
| `wecom-cli` 单条待办创建工具                    | 完成并真实验证，默认关闭  | 精确 argv、参数二次校验、具体审批摘要、返回 ID 移除                               |
| Kernel 审批截止与孤立审批回收                   | 完成并自动化验证          | Adapter 较短上限；turn 先结束即中断该 run 的 pending                              |
| 独立持久审批提示                                | 完成并自动化验证          | 主动 Bot 消息不受 Agent 流覆盖；Transport 不支持时 fail closed                    |
| Channel-neutral 五类结构化卡片                  | Phase 1 完成并自动化验证  | 通知/图文/按钮/投票/表单映射官方 SDK；不接收厂商 JSON                             |
| 审批按钮卡片与 SQLite 交互状态                  | 批准链路真实通过          | 回调 ACL/幂等/发送者/会话/失效绑定；五秒内原位更新；拒绝/过期/中断仍待真实矩阵    |
| 耐久通用 Interaction Broker                     | M2.1 完成并自动化验证     | 单选/多选/取消/TTL；五秒 fast lane；同 session resume；租约/重试/死信             |
| Pi 原生 ask-user 交互桥                         | M2.2 真实矩阵通过         | 私聊 select/input、群聊 select；native response；live resume；限定文本回复        |
| Codex App Server 原生 ask-user                  | M2.4 自动化通过           | 原 request ID 响应；单选/表单/自由输入/多步；secret fail-closed；同一 turn        |
| 单选卡片可读性与颜色语义                        | 私聊与群聊真实通过        | 完整标签、无首项偏置、显式 action style、禁用完成态、重复回调幂等                 |
| 最终回复快捷操作                                | M2.3 自动化与真实验证通过 | 紧邻主动卡、SQLite TTL/幂等、同 session continuation、默认动作一次性              |
| 多 Kernel 回复动作续接                          | M2.4 自动化通过           | Codex SDK/App Server、ACP/Kimi、OpenClaw、Pi、外部模板共用 deterministic contract |
| 长任务原生取消控制卡                            | M2.5 真实私聊通过         | 仅 cancellable Adapter；控制卡单次结算；Pi 原生 run 真实进入 cancelled            |
| 动态状态文字与组合卡边界                        | M2.5 自动化/真实验证      | 显式 status/emoji 进入可变文字；首帧卡客户端不可见，控制走阈值主动卡              |
| SQLite 重启恢复                                 | 完成并自动化验证          | 入站去重、runtime session、待发送文本与投递日志跨 reopen 保留                     |
| SQLite 文件权限                                 | 完成并自动化验证          | Store 每次打开都强制主数据库为 `0600`；本机现有数据库已收紧                       |
| SQLite 故障因果保留                             | 完成并自动化验证          | 写入/提交失败后即使回滚也失败，仍抛出原始故障而非二次回滚错误                     |
| 文本持久化 Outbox                               | 完成并自动化验证          | 发送前提交、事务认领、租约过期接管、指数退避与死信                                |
| OS 进程强杀后的 Outbox 恢复                     | 完成并自动化验证          | 子进程持有 SQLite 租约时 `SIGKILL`；新进程租约过期后恢复并完成唯一投递            |
| 流式待发版本替代                                | 完成并自动化验证          | 同一 stream 只恢复最新 pending 状态，旧 partial 标记 superseded                   |
| Outbox 分会话调度                               | 完成并自动化验证          | 同会话有序、不同会话并发，不引入全局队头阻塞                                      |
| Outbox 无标识生命周期指标                       | 完成并自动化验证          | 阶段、命令类型、尝试次数；不含消息/会话/目标 ID                                   |
| 有界入站与 Agent 并发                           | 完成并自动化验证          | ACL 前置；全局/单会话待处理上限、run semaphore、无标识拒绝事件                    |
| 死信聚合与受限重排                              | 完成并自动化验证          | 仅统计数量；显式确认后只重排最终回复/主动文本，不含 partial/媒体                  |
| Fail-closed ACL                                 | 完成并自动化验证          | sender/conversation allowlist；空配置拒绝启动                                     |
| 流式窗口过期降级                                | 完成并自动化验证          | 官方错误码 `846608` 的最终文本改走 Bot `sendMessage`                              |
| SDK/Adapter/Outbox 故障恢复                     | 完成并自动化/受管验证     | 重新鉴权后续投递、失败 Pi client 替换、租约/媒体恢复、受管重启                    |
| 凭据日志脱敏                                    | 完成并自动化验证          | Bot 凭据与常见 secret/token/authorization 字段替换为 `[REDACTED]`                 |
| 分域精确白名单与私聊挑战注册                    | 完成并自动化验证          | 私聊从真实回调注册；群聊从最新会话唯一匹配；内部 ID 不输出                        |

## 真实企业微信联调记录

| 日期       | 场景                          | 结果   | 说明                                                                                                     |
| ---------- | ----------------------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| 2026-08-20 | Bot → 授权测试私聊            | 通过   | `wecom-cli` 主动发送 Markdown 成功                                                                       |
| 2026-08-20 | 解析私聊精确白名单            | 通过   | 已写入本机权限为 `0600` 的忽略文件 `.env`，未记录或展示内部 ID                                           |
| 2026-08-20 | 清理重复同名 Bot              | 通过   | 删除零使用、无办公权限且非当前授权身份的重复 Bot；正式 Bot 未修改                                        |
| 2026-08-20 | 发现授权测试群聊              | 通过   | 群内 @Bot 后从最新会话列表唯一精确匹配                                                                   |
| 2026-08-20 | Bot → 授权测试群聊            | 通过   | `wecom-cli` 主动发送 Markdown 成功                                                                       |
| 2026-08-20 | 双会话分域精确白名单          | 通过   | 私聊挑战注册、群聊会话匹配均完成；旧的全局 allowlist 为空                                                |
| 2026-08-20 | Gateway WebSocket 鉴权        | 通过   | 官方 SDK 真实连接、鉴权和心跳启动成功                                                                    |
| 2026-08-20 | 私聊 → Codex → 流式回复       | 通过   | ACL 放行、即时首帧、低推理强度 Codex 最终完整文本和客户端更新通过                                        |
| 2026-08-20 | 进程重启后的私聊会话恢复      | 通过   | SQLite 中既有会话被新进程复用，重启后消息仍完整回复                                                      |
| 2026-08-20 | 私聊连续多轮上下文            | 通过   | 后续消息正确引用上一轮指定文本，确认复用同一 Codex thread                                                |
| 2026-08-20 | 群聊 @Bot → Codex → 回复      | 通过   | 真实富文本 @、group-only ACL、即时首帧和最终完整文本均通过                                               |
| 2026-08-20 | 持久 App Server 私聊首轮      | 通过   | Channel 回执 415ms、Kernel 首事件 171ms；WebSocket 重试使首文本达 113.7s，已定位                         |
| 2026-08-20 | 持久 App Server 私聊第二轮    | 通过   | Channel 回执 369ms、Kernel 首文本 5.2s、总耗时 6.1s，确认会话和进程复用有效                              |
| 2026-08-20 | HTTP-only 冷/热基准           | 通过   | 冷轮首文本 6.7s/总计 6.9s；同线程热轮首文本 2.2s/总计 2.6s                                               |
| 2026-08-20 | HTTP-only 真实私聊端到端      | 通过   | Channel 回执 452ms、Kernel 首文本 3.88s、端到端完成 5.12s；用户端确认明显变快                            |
| 2026-08-20 | 私聊文字 + 图片 → Codex       | 通过   | 两个回调按会话顺序执行；SDK 下载与 AES 解密成功、原生图片 turn 完成、临时目录清零                        |
| 2026-08-20 | Gateway → 私聊图片            | 通过   | 允许根目录内图片经官方 SDK 上传并由正式 Bot 主动发送；目标与 media_id 未输出                             |
| 2026-08-21 | 媒体 Outbox 重启恢复 → 私聊   | 通过   | artifact 入队后删除原文件、重建 Store/Spool/Gateway，官方上传发送成功且用户确认客户端可见                |
| 2026-08-21 | Codex → 动态工具 → 联系人搜索 | 通过   | 官方 App Server 实验协议真实调用一次只读 `wecom-cli`；返回可读姓名/职务/部门，未暴露内部 ID              |
| 2026-08-21 | 私聊 → Codex → 联系人动态工具 | 通过   | ACL、456ms 首回执、4.26s Kernel 首文本、13.1s 完成；10 次可变更新全成功，Outbox 无积压/死信              |
| 2026-08-24 | 私聊待办审批首次复测          | 未通过 | Gateway/Bot 在线、工具未启动且未创建待办；先暴露 Codex 截止早于 5 分钟，后确认可变回复会立即覆盖审批提示 |
| 2026-08-24 | 私聊待办独立审批 → 创建       | 通过   | 独立主动提示一次送达；17.4s 获批，工具仅启动一次并在 1.4s 成功，29.9s 完成；Outbox 无积压                |
| 2026-08-24 | 唯一测试待办清理              | 通过   | 创建后按唯一标题核对为 1 条，删除成功并复查为 0；全程未记录或展示内部 ID                                 |
| 2026-08-24 | 本机 Kimi ACP 两轮 smoke      | 通过   | 官方 ACP v1；流式和 session 恢复通过，协商图片输入能力，总耗时 13.0s                                     |
| 2026-08-24 | 私聊 → Kimi ACP → 流式回复    | 通过   | Channel 回执 418ms、Kimi 首文本 5.68s、端到端 6.42s；独立 Kimi session 写入                              |
| 2026-08-24 | 同一私聊图片 → Kimi ACP       | 通过   | 仍为同一 session；物化 356ms、首文本 10.97s、总计 13.23s，Outbox 全投递且临时目录归零                    |
| 2026-08-24 | 本机 OpenClaw → GLM-5.2 两轮  | 通过   | 官方 Gateway Client；首轮 8.2s、续接轮 6.4s，严格回复与 session 恢复通过；无 Codex 登录                  |
| 2026-08-24 | 私聊 → OpenClaw → GLM-5.2     | 通过   | Channel 回执 405ms、首文本 12.09s、端到端 15.13s；多次可变更新成功，Outbox 全 delivered                  |
| 2026-08-24 | OpenClaw 私聊同会话第二轮     | 通过   | session 分区仍为 1；回执 446ms、首文本 8.46s、端到端 9.98s；上下文回答正确                               |
| 2026-08-24 | 同一 OpenClaw 私聊图片        | 通过   | 回执 405ms、物化 2.85s、首文本 46.48s、总计 50.89s；清理归零且无敏感字段持久化                           |
| 2026-08-24 | OpenClaw LaunchAgent 受管重启 | 通过   | `start:checked` 9/9；PID 更替后 Adapter ready、Bot 重新鉴权，钥匙串 token 未落盘                         |
| 2026-08-24 | 群聊 @Bot → OpenClaw → GLM    | 通过   | group-only ACL；回执 874ms、首文本 23.05s、总计 25.20s；独立群 session，Outbox 全 delivered              |
| 2026-08-24 | 本机 Pi RPC → ZAI/GLM-5.2     | 通过   | 官方 JSONL RPC；首轮 6.745s、恢复轮 3.595s、总计 10.93s；严格回复与同 session 恢复正确                   |
| 2026-08-24 | 私聊 → Pi RPC → GLM-5.2 两轮  | 通过   | 回执 400/385ms、首文本 3.919/2.638s、总计 4.610/3.382s；上下文正确且仅 1 个 Pi session                   |
| 2026-08-24 | Pi/Gateway 重启后私聊恢复     | 通过   | 重新鉴权后两轮上下文正确；回执 432/392ms、首文本 3.475/3.992s、总计 4.885/4.833s；Outbox 81 条全投递     |
| 2026-08-24 | Pi LaunchAgent 受管重启       | 通过   | `start:checked` 8/8；进程更替后 Pi ready、Bot 重新鉴权；Key 仅在 Pi 私有 auth，不在 plist                |
| 2026-08-24 | 本机 Pi RPC → GLM-4.6V 图片   | 通过   | 自定义 `zai-vision`；动态协商 images=yes，真实截图文字命中，总计 8.215s；无凭据或图片内容输出            |
| 2026-08-24 | Pi/GLM-4.6V 纯图片兼容探测    | 已修复 | 空 message 稳定缺失 `finish_reason`；单空格 wire padding 成功，不注入语义提示                            |
| 2026-08-24 | 私聊纯图片 → Pi → GLM-4.6V    | 通过   | 回执 397ms、物化 314ms、首文本 10.812s、总计 15.414s；新 session、Outbox 全投递、临时目录归零            |
| 2026-08-24 | 本机 Pi 两 session 并发       | 通过   | 两轮分别 6.373/6.876s，总墙钟 6.877s，确认默认 2-worker pool 真实重叠执行                                |
| 2026-08-24 | Pi pool 受管强制重启          | 通过   | 重启前后均为 2 个 Pi worker；Adapter ready 后 Bot WebSocket 重新鉴权                                     |
| 2026-08-24 | 私聊文件 → OpenClaw           | 通过   | 回执 441ms、物化 2.317s、首文本 7.786s、总计 12.131s；Outbox 全投递、临时目录归零                        |
| 2026-08-24 | 私聊 MP4 → OpenClaw           | 通过   | 桌面端回调为普通 file；回执 446ms、物化 1.147s、首文本 34.394s、总计 37.510s；Agent 收到视频二进制       |
| 2026-08-24 | 本地控制面 → 主动私聊         | 通过   | 0600 socket；`direct` 别名；同一 Gateway/Outbox/官方 SDK 投递，用户确认客户端可见                        |
| 2026-08-24 | 本地控制面 → 主动群聊         | 通过   | `group` 别名；与私聊按会话投递，用户确认客户端可见                                                       |
| 2026-08-24 | 本地控制面 → 主动私聊文件     | 通过   | 允许根目录文件经 spool/官方上传主动发送；用户确认可见，Outbox 148 delivered、无 pending/dead             |
| 2026-08-24 | 受管 Pi → 运维观测端点        | 通过   | 强制重启后重新鉴权；live/ready/metrics 均 200，27 行指标无 ID/Secret label，原控制面健康                 |
| 2026-08-24 | 非 root 生产容器镜像          | 通过   | 固定 Node digest；构建成功，UID 10001、内部 healthcheck、无 `.env`，断网可加载 Core/Observability        |
| 2026-08-25 | Pi LaunchAgent 真实 SIGKILL   | 通过   | PID 更替并自动拉起；Pi ready、Bot 重新鉴权、健康/控制面 ready；Outbox 148 delivered、零积压              |
| 2026-08-25 | 隔离 Linux 网络断开与恢复     | 通过   | 官方 SDK disconnected、ready 降级；1/2/4/8/16s 退避后随网络恢复自动 authenticated、ready 恢复            |
| 2026-08-25 | SQLite 持久卷只读与恢复       | 通过   | 同一卷 `:ro` 时真实 EROFS 并 fail closed；恢复读写后数据库、Adapter、官方连接和健康全部恢复              |
| 2026-08-25 | SQLite 受限容量耗尽与恢复     | 通过   | 无网络 2MB Linux tmpfs 触发磁盘已满；释放预留空间后 42 条已提交记录全部可读、无 dead                     |
| 2026-08-25 | Pi 私聊单选交互               | 通过   | 纵向完整选项、仅提交为主色；原 run 仅恢复一次；完成态原位更新成功，重复提交不再恢复 Agent                |
| 2026-08-25 | Pi 私聊限定文本输入           | 通过   | 下一条同范围文本被 Broker 消费；17.744s 提交、1ms 恢复原 run；未创建第二个 Agent turn                    |
| 2026-08-25 | Pi 群聊单选交互               | 通过   | group-only ACL；440ms 回执、3.847s 首文本、16.433s 提交、1ms 恢复；更新与最终回复无错误                  |
| 2026-08-26 | Pi 私聊最终回复快捷操作       | 通过   | 446ms 回执、9.693s 首文本；仅一张默认卡；点击后同 session 续跑且不再生成卡；Outbox 零积压/死信           |
| 2026-08-28 | Pi 私聊长任务停止卡           | 通过   | 点击后 SQLite 控制记录仅一次 resolved/cancel；原 run 于 21.045s 进入 cancelled；Outbox 零积压/死信       |
| 2026-08-28 | Pi 私聊组合流首帧卡           | 不通过 | 服务端投递成功且仅一帧含卡；macOS 客户端只显示文字，首帧卡不可见；不得用于运行控制                       |
| 2026-08-28 | Pi 私聊动态状态与最终动作     | 通过   | 状态/正文同一消息更新；最终只保留“接下来”动作卡，未出现陈旧的同消息停止卡                                |
| 2026-08-28 | Pi 私聊自动化原生取消         | 通过   | UI 两轮长任务点击“停止本轮”；33.521s/34.204s cancelled；551 delivered，零积压/死信                       |
| 2026-08-28 | 生产默认动作卡关闭回归        | 通过   | 清理 LaunchAgent 演示配置；私聊/群聊普通回复无动作卡；显式 confirm 卡点击与原 Pi run 恢复仍通过          |

### 延迟结论

分钟级首轮延迟已定位到 Codex CLI `0.145.0` 的 Responses WebSocket 冷路径：当前网络中连接失败后
连续重试 5 次，才回退 HTTP/SSE。Gateway 的企业微信接收、ACL、排队和可变消息首回执均为亚秒级，
不是这次分钟级延迟的来源。切换后真实私聊端到端完成为 5.12 秒。参考 adapter 默认使用独立的
ChatGPT-auth-compatible HTTP-only provider，保留现有 ChatGPT 登录身份，不改用 API Key 计费；
可通过 `CODEX_RESPONSES_WEBSOCKET=true` 显式恢复内置 provider。该配置是 Codex adapter 的传输
实现细节，不进入通用 Channel 契约。

实测命令为 `pnpm benchmark:codex-app-server`，每次运行创建独立测试 thread，并在同一 thread 连续
执行两个无副作用文本回合。官方 App Server 协议见
[Codex App Server](https://learn.chatgpt.com/docs/app-server)，provider 配置字段见
[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 未声称已通过的真实联调

- 宿主机级物理网卡/路由/DNS 中断；隔离 Linux network namespace detach 后的官方 SDK 断线、退避、重鉴权
  和 ready 降级/恢复已通过，不能冒充整机网络栈验收。
- 引用消息和事件回调（私聊和群聊文本已通过）。
- 写工具拒绝与进程重启中断的真实企业微信客户端验收；批准、超时和测试待办清理已真实通过。
- 原生企业微信 `msgtype=video` 的真实客户端回调；官方 frame 的 video/file 归一化已有自动化覆盖，
  文件与 MP4 二进制已在真实私聊通过，但该桌面端把 MP4 作为普通 `file` 回调。
- 语音在官方回调中当前只有转写文本；不存在可供下载的原始音频 URL。
- 具体 Kernel adapter 产生真实 `media-output`（通用 contract、Gateway 与企业微信发送链路已通过）。
- 主动消息的完整会话范围、频控和真实失败重试。
- 文本/媒体 outbox 已自动化通过；媒体模拟进程重启后的真实官方发送已通过。真实 OS 子进程在
  SQLite 投递已租用、发送未返回时被 `SIGKILL`，新进程租约恢复也已自动化通过。有界单实例背压、
  受限死信 CLI、Pi 强制受管重启、SDK 网络恢复、真实只读卷和受限容量耗尽恢复已完成；宿主机级
  网络中断、多实例全局顺序和共享背压未完成。

Beta 传输闭环已经成立：文本、图片、文件、MP4 二进制、流式可变消息、会话恢复、并发与持久化
投递均有自动化或真实证据；Codex、Kimi、OpenClaw、Pi 四种真实接入已证明 Adapter 契约中立。
MP4 验收中 Agent 明确报告缺少视频解析工具，属于 Kernel 工具能力，不是 Gateway 链路失败。
可部署检查基线、OpenClaw 本机 GLM 两轮、企业微信私聊文本/恢复/图片、授权群聊和受管服务均已完成。
OpenClaw 第三 Kernel 阶段闭环；Adapter 公共契约 v1、启动期拒绝和版本兼容矩阵也已固化。Pi 官方
JSONL RPC Adapter 的代码、Registry、Doctor、两轮 smoke 与 fake contract 已完成；Pi `0.84.2`、
ZAI/GLM-5.2 本机两轮、授权企业微信私聊连续回复和进程重启后 session 恢复均已通过。GLM-5.2
明确不支持图片，Adapter 已动态关闭该 capability；切换到声明 image input 的 GLM-4.6V 后，本机和
企业微信纯图片真实验收均已通过。

## 当前人工门槛

本机 `wecom-cli 1.1.0` 已授权。专用测试成员和测试群分别写入 direct-only sender 与 group-only
conversation allowlist，真实名称只存在于本机忽略配置；旧的全局 allowlist 保持为空，防止授权范围
跨会话类型扩散。Bot 凭据仍不得进入聊天、issue、PR 或普通日志。

## 仓库治理

- 同名发布仓库已公开并进入 Public Preview；原仓库已改名并保持 private，发布仓库由审计后的干净
  根提交重新创建。未登录 API、README、SECURITY 和 Git refs 访问均已复核。
- 项目自有代码采用与企业微信官方核心参考项目一致的 MIT；依赖许可证和来源规则已形成独立审计文档。
- GitHub Actions 运行格式、TypeScript、179 项 deterministic tests、公开面和依赖许可证检查。
- 已完成模式 `0600` 的最终离库 Git bundle 备份、旧仓库全部 refs 与 51 次 Actions 日志审计；旧历史
  确认包含私密名称和非 noreply 作者元数据，只保留在私有归档与离线 bundle。新的同名发布仓库从
  1 个审计后的根提交建立，GitHub CI、全新 clone、141 项测试和私密词扫描均通过；Dependabot 随后
  创建的提交与 pull refs 也纳入全引用审计，不连接任何旧历史。
- Actions 依赖已固定到官方 tag 对应的不可变 commit SHA。Private Vulnerability Reporting 已启用；
  `main` 强制 `verify` CI、线性历史和会话解决，规则适用于管理员，并禁止 force-push 与分支删除。
- 已生成并目视复核 1280×640 社交预览资产，不使用企业微信官方 Logo 或机器人形象，避免暗示官方
  背书；已由仓库所有者上传为 GitHub Social Preview。
- squash merge、自动删除分支、Dependabot 漏洞告警和自动安全修复已启用；历史净化、默认分支保护、
  Private Vulnerability Reporting 和未登录视角复核均已完成。`v0.1.0` 已通过 tag-triggered GitHub
  Actions 发布可复现源码包和 SHA-256，并以 GitHub/Sigstore provenance 通过消费者侧验证；Social
  Preview 已上传。

## 下一阶段

### M2.1：Interaction Broker

- 已确认卡片不是 Agent 生成的厂商 JSON，而是 Gateway 通用交互协议；SDK 负责呈现与回调，Core
  负责状态/权限/幂等/TTL/续跑，Adapter 负责 Kernel 翻译，`wecom-cli` 负责选择后的办公动作。
- 设计已固化在 `docs/interaction-cards.md` 和 ADR 0021：五秒 callback fast lane 不等待 Kernel；
  默认 deferred suspend/resume；交互结果经带租约的 durable resume queue 恢复。
- M2.1 已实现 Agent-neutral Request/Result、`interaction-resume` capability、SQLite 原子
  resolve/enqueue、TTL sweep、租约恢复、退避重试/死信、即时卡片更新和新的主动回复边界。
- deterministic adapter 已覆盖单选、多选、表单、取消、过期、重复点击、跨发送者 ACL 和同 session 恢复；
  SQLite 测试覆盖租约过期接管。真实企业微信私聊单选与授权群单选均已通过。

### M2.2：Agent ask-user 接入

- 已选择 Pi 作为首个真实 Kernel：Adapter 把官方 RPC `extension_ui_request` 的
  select/confirm/input/editor 翻译为现有中立请求，不改动 WeCom Transport 协议，也不合成 Prompt。
- 新增 `interaction-requested`、`text-input` 与 `interaction-live-resume`。原调用仍等待时，resume 作为
  控制响应直达绑定 worker，绕过语义 run 队列以避免死锁；durable resume entry 仍记录 callback 决定与
  at-least-once 投递。
- Gateway 强制每 account + conversation 只有一个 pending interaction；开放输入只消费同 sender 的
  下一条非空纯文本，不创建第二个 Agent turn。
- 179 项 deterministic tests 已通过；本机 Pi `0.84.2` 加载仓库示例后真实产生 select request，接受
  “测试环境”的 native response，原 tool result 得到该值且同一 run 最终回复“测试完成”。授权私聊
  单选与限定文本输入已完成真实闭环；授权测试群的单选也已通过 group-only ACL 和完整交互链路。
- 首轮真实私聊 select 已证明 Pi 原 run 完成且多次点击只产生一次 resume，但结果 notice 的
  `card_action:{type:0}` 被服务端以 `42045` 拒绝；横排按钮还导致文字不全和首项蓝色偏置。该轮记为部分
  通过。第二轮已确认纵向 vote 能提交、9 秒内收到用户选择、live resume 仅 1ms 且恰好一次；但按官方
  示例省略 `card_action` 的结果 notice 仍返回相同 `42045`。第三轮禁用 vote 已越过该校验，但服务端因
  缺少必填 `submit_button.text` 返回 `42049`；提交约 12.8 秒、live resume 2ms 且恰好一次。第四轮完成态
  补齐“已完成”按钮后，旧卡重复提交触发的原位更新被企业微信接受且无错误；durable resume 数量仍为
  1，证明 UI 可收敛而 Agent 业务不会重复执行。私聊单选验收至此关闭。
- 私聊 `text-input` 真实请求在用户输入后 17.744 秒提交，live resume 1ms 且一次投递成功；该文本由
  scoped Broker 消费并恢复原 Pi run，没有创建新的 Agent turn，最终回复投递无错误。
- 授权测试群 select 的 Channel 回执 440ms、Pi 首文本 3.847 秒、用户提交 16.433 秒、live resume 1ms；
  两次完成态更新与最终回复均无错误，整个回合 25.676 秒完成且 resume 恰好一次。跨发送者拒绝继续由
  deterministic ACL 覆盖，不把缺少第二位真人的测试环境伪装成真实跨成员验收。

### M2.3：最终回复快捷操作

- 最终流式正文完成后通过 durable proactive path 紧邻发送 action card；真实客户端不会稳定显示只在
  最后一帧首次加入的组合卡，因此不以服务端成功回执冒充可见。
- 私聊真实复测已确认普通回合只投递一张快捷卡，点击后同 session new-turn continuation 成功；默认
  action 不继承到自己的 callback 回合，链路自然终止，Outbox 零积压/死信。
- 全局默认动作是 opt-in 演示/运营配置，不是通用卡片能力的开关。2026-08-28 已清理受管 Pi 服务中的
  残留配置：私聊与授权群聊普通回复均没有 `proactive-presentation`，显式 confirm 交互仍完整通过。

### M2.4：多 Kernel 交互

- Codex SDK/App Server、ACP/Kimi、OpenClaw、Pi 与外部 Adapter 模板共用 reply-action contract。
- Codex App Server 原生 `item/tool/requestUserInput` 已覆盖单选、表单、自由输入、多步同 turn 恢复和
  secret fail-closed；Pi 使用原生 extension UI response。
- 固定版本协议审计确认 ACP v1 只有工具 permission，OpenClaw Gateway v4 没有导出外部 elicitation
  response；这两个 Adapter 不虚报 live ask-user，也不使用 synthetic Prompt。

### M2.5：高级交互

- 第一切片已实现长任务取消卡：应用默认 15 秒阈值，只对同时具备原生 `cancel` 和可交互 Transport 的
  run 展示；SQLite 持久绑定 account/conversation/sender/TTL，首次点击原位确认后取消原 session。
- 自动化覆盖快速/不可取消任务不展示、跨 sender 拒绝、重复静默、正常结束旧卡收敛和 SQLite 过期。
  2026-08-28 真实企业微信私聊验收确认：控制卡一次点击后只产生一条 `resolved/cancel` 记录，Pi
  原生 run 在 21.045 秒进入 `cancelled`，没有继续完成该 run；Outbox 为 307 delivered、零
  pending/leased/dead，Gateway 保持 ready。
- 第二切片收敛为动态状态文字 + 真实组合流边界：SDK 明确规定同一 stream 的 `template_card` 只能回复
  一次，因此 Adapter `status`/emoji 只进入 250ms 合并的可变文字。2026-08-28 本机 UI 自动验收确认，
  首帧仅发送一次卡片时 macOS 客户端不可见；重复附卡虽可能出现却违反官方契约。因此运行控制保留
  已真实验证的阈值主动卡，首帧组合卡不进入生产 UX。
- 后续只把欢迎、主动任务卡和独立群投票聚合作为可选能力；新增主题与卡片样式不再排在 IM 保真前面。

### 2026-08-28 主线与官方生态复核

- 重新检查 Runtime Contract、Core、WeCom Transport 和各 Adapter 后确认：厂商卡片 JSON 只存在于
  Transport 映射，普通回复默认不附卡，Kernel 不需要支持卡片即可完成文本、媒体、流式和 session。
- 对照官方 Node SDK、OpenClaw 插件、`wecom-cli 1.2.0` 与 `wecom-unified` 后，将引用/回复上下文保真、
  `replyStreamNonBlocking` 背压和最终 durable delivery 列为 P0；feedback event、静态 `enter_chat`
  welcome 列为 P1；Bot Webhook 作为独立可选 Transport 评估。
- 官方插件的自然语言动态 Agent 路由、多账号业务编排、LLM 文本卡片 JSON 提取和内存 callback 表不进入
  Core。`wecom-cli` / `wecom-unified` 的完整办公能力继续由 Kernel 工具层拥有。
- 新增 `verified-kernel-cases.md` 与英文镜像，汇总 Codex、Kimi/ACP、OpenClaw、Pi 的真实企业微信场景、
  分层延迟和 smoke 入口；Pi 案例附带一张裁剪、隐私复核后的真实客户端截图。

### M5：生产运行与韧性

- 已提供 Linux/systemd、Dockerfile/Compose、专用用户和只读/最小权限参考配置；容器不打包任何凭据或
  Agent Kernel，进程型 Kernel 必须使用固定版本的派生镜像。本机 Compose 配置解析、镜像构建和断网
  runtime import smoke 已通过。
- 已实现 loopback-only `livez/readyz/metrics`、聚合 Core snapshot 和无用户数据指标；远程采集必须由
  同主机 collector 或受限代理承担，Gateway 不开放公网观测面。
- 已补齐真实 OS 子进程持租约时 `SIGKILL` → 新进程 SQLite Outbox 恢复，以及 macOS Pi LaunchAgent
  强杀拉起、Adapter ready、官方 WebSocket 重鉴权、健康与零积压复核。隔离 Linux 官方 SDK 网络
  detach/reconnect、真实只读持久卷和 2MB tmpfs 容量耗尽/恢复也已通过。下一步只保留需要独立主机的
  Linux/systemd 长时间运行与宿主机级网络中断；多实例所有权、共享背压和全局会话顺序仍是明确
  未完成边界。

### M1：通用文本 Channel 闭环

- 已完成私聊、群聊真实 @、分域 ACL、即时流式首帧、最终完整文本、连续多轮和重启恢复。
- 已完成结构化 SDK/访问日志、凭据脱敏和流式窗口过期主动推送降级。
- 已完成中性接收回执、Agent 显式状态/emoji 契约和可变消息增量合并；不再由 Channel 伪造 Agent 状态。
- Gateway 原生主动控制面代码已完成：唯一 scoped 私聊/群聊自动使用 `direct` / `group` 别名，多目标
  必须显式映射且不能越过分域白名单；文本/媒体共用 Outbox。真实私聊、群聊和文件均已完成客户端验收。

### M2：媒体与可靠传输

- 已复用 SDK `downloadFile` 完成入站媒体下载/AES 解密、MIME 探测、大小限制、受保护临时物化、运行后清理和持久化脱敏。
- 真实图片输入与输出上传/发送均已通过；Gateway 自管耐久 spool、媒体 outbox、完整性、配额、孤儿回收和重启恢复已完成自动化。下一步执行授权会话的真实媒体失败恢复；恶意内容扫描仍待部署策略。
- 文本/媒体 outbox、Adapter、流式、session、工具、审批、结构化卡片与主动控制面已完成自动化验证；
  OS 子进程强杀和 SQLite 原始故障保留已纳入 CI。宿主机网络故障、告警接入和多实例顺序保留为
  部署硬化，不把 Agent 推理或模型效果混入 Gateway 主线。
- Codex App Server 与 Kimi ACP 均在不产生虚假 turn、不注入 Prompt 的前提下完成真实分层测量；同一口径继续用于后续 Kernel。

### M3：审批与工具事件

- 已定义 Kernel-neutral `RuntimeTool`，完成 Codex `dynamicTools` / `item/tool/call` 协议桥、超时、
  输出上限、未知工具拒绝、通用失败脱敏，以及不含参数/结果/内部 ID 的工具生命周期日志。
- 已注册第一个精确只读工具 `wecom_contact_search`；使用官方 CLI 当前 schema、独立授权目录与
  `execFile`，不允许模型提供命令路径或自由 argv；本机真实 Codex 工具 smoke 已通过。
- 企业微信私聊 → Codex → 联系人动态工具已真实通过。持久审批状态机已完成：精确 `/approve` /
  `/deny` 控制命令、account/conversation/sender 绑定、SQLite 审计、幂等决定、Gateway 五分钟
  策略上限与 Codex 90 秒协议上限、停机/重启/turn 结束中断，以及无参数/结果/内部 ID 的生命周期
  日志均有自动化验证。
- Codex adapter 只接受 `read-only + never` 或 `write/destructive + required`，并在 `approved` 前绝不
  调用写工具。首个最小可逆工具 `wecom_todo_create` 已实现为单条创建：审批展示具体标题/截止
  时间，CLI 返回中的待办和成员 ID 不进入 Agent；独立开关默认关闭。首次真实请求暴露 Gateway
  五分钟窗口长于 Codex 工具等待，收紧为 90 秒后的第二次复测又确认审批提示会被相邻 Agent 状态
  覆盖。改为独立持久 Bot 控制消息后，私聊批准链路已真实通过：17.4 秒获批、工具恰好启动一次、
  1.4 秒执行成功、29.9 秒完成，测试待办随后删除并复查归零。下一步完成真实拒绝、重启中断与
  故障注入；Kernel turn 先结束时仍回收孤立审批。

### M4：多 Kernel

- 已完成配置驱动 Registry 与通用 ACP v1 Adapter；ACP/Kimi 类型仅存在于独立 Adapter package。
- Codex 与 ACP 已运行同一组 runtime-neutral 文本、流式和 session 恢复 contract tests。
- Kimi Code 已完成本机真实两轮 smoke、企业微信私聊文本、同会话恢复和图片输入，第二 Kernel 闭环。
- OpenClaw 已通过官方 Gateway WebSocket Client 接入，本机既有 GLM-5.2 两轮恢复成功，且以终态
  对账消除了版本/连接事件间隙导致的假超时；不依赖 Codex 登录或模型 API Key 迁移。
- `doctor`、live health、checked start 与 macOS LaunchAgent 已形成最小部署基线；OpenClaw 企业微信
  私聊流式/恢复/图片、授权群聊均已通过，受管重启后重新鉴权成功。Adapter 兼容矩阵已经固化。
- Runtime Contract v1 现在是显式、运行时校验的公共边界；错误版本和重复 ID 在 Adapter 启动前失败。
  已记录 Codex、ACP/Kimi、OpenClaw 的固定/实测版本与 capability 语义。
- Pi 官方接口已核验为严格 LF JSONL RPC/Node SDK，不是 ACP。独立 Adapter 已映射 prompt、图片、
  文本增量、完全终态、abort 和 session switch，并以默认 2-worker 有界池保持资源可控；同 session
  keyed lock 串行、不同 session 真实并行。本机
  ZAI/GLM-5.2、企业微信文本/恢复及进程重启恢复已真实通过。图片按当前模型输入动态协商，不能用
  GLM-5.2 完成不存在的视觉能力验收。

## 外部文档关系

`wecom-cli` 的历史功能与测试记录保留在
[`fyaic/wecom-cli` Draft PR #2](https://github.com/fyaic/wecom-cli/pull/2)。本仓库的 ADR 和状态是 Channel 项目的权威来源；两边通过链接关联，不复制易漂移的测试结论。
