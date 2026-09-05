# 企业微信上游兼容矩阵

快照日期：2026-09-04。本文只记录会影响 IM Gateway 传输、顺序、去重、媒体和可观测性的上游行为；
模型效果、OpenClaw 路由与 `wecom-cli` 办公工具不属于本矩阵。

## 版本基线

| 上游                                                                          | 当前基线        | 本项目关系                                   | 升级策略                                               |
| ----------------------------------------------------------------------------- | --------------- | -------------------------------------------- | ------------------------------------------------------ |
| [`@wecom/aibot-node-sdk`](https://github.com/WecomTeam/aibot-node-sdk)        | npm `1.0.7`     | Transport 唯一正式协议实现，精确锁定 `1.0.7` | 不使用范围版本；升级必须跑本页矩阵、完整 CI 和授权沙箱 |
| [`wecom-openclaw-plugin`](https://github.com/WecomTeam/wecom-openclaw-plugin) | npm `2026.8.17` | 官方真实应用参考，不作为依赖                 | issue/release 只转化为中立 Gateway 故障 fixture        |
| [`wecom-cli`](https://github.com/WecomTeam/wecom-cli)                         | npm `1.2.0`     | 可选 Agent 工具层                            | 不承担 WebSocket Channel、历史消息或真人身份           |

版本以 npm `latest` 与仓库 `pnpm-lock.yaml` 为准。GitHub 仓库没有对应 release/tag 时，不用网页显示的
提交日期替代 npm 包版本；依赖完整性继续由锁文件策略和公开仓库检查验证。

2026-09-04 复核：三个官方仓库的记录 commit 与本页基线一致，SDK npm 仍为
`1.0.7`。新增社区信号主要是 OpenClaw 升级后的插件 runtime 初始化失败
（官方插件 [#183](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/183)、
[#184](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/184)），以及
`wecom-cli` 群历史能力在部分企业仍不可用（CLI
[#132](https://github.com/WecomTeam/wecom-cli/issues/132)），以及写能力可能独立返回
`850003 authorization expired` 而读取仍正常（CLI
[#134](https://github.com/WecomTeam/wecom-cli/issues/134)）。前者再次说明 Kernel/工具运行时必须隔离在
Adapter/Tool 边界；群历史问题不改变本项目 Bot-only、实时 callback、不拉历史消息的范围。授权失效则已
转化为 Tool 层的稳定、不可误重试结果：不向 Agent 透出 CLI 原始输出、凭据或路径，写工具继续默认关闭。

## 固定回归矩阵

2026-09-05：再次查询 SDK npm `latest` 为 `1.0.7`，无升级变更。补充
[中间层社区观察](middleware-community-review.md)，区分上游 Issue 报告、未合并 PR 与本项目已验证措施。
本轮 `pnpm run ci` 通过 36 个测试文件 / 281 项测试，包含本页固定回归所引用的 Transport/Core/Storage 用例。

运行：

```bash
pnpm test:m3-upstream-compatibility
```

| 风险                      | 上游信号                                                                                                                                                                                                                     | 本项目语义                                                                                                       | 确定性证据                                                            | 状态       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------- |
| ACK 晚于五秒              | SDK [#27](https://github.com/WecomTeam/aibot-node-sdk/issues/27)                                                                                                                                                             | 同 `req_id` ACK 未完成时丢弃陈旧 partial，final 始终提交；final 仍由耐久 Outbox 负责                             | late-ACK fake；Transport `replyStreamNonBlocking`；Outbox final retry | 通过       |
| 回复队列溢出              | SDK [#5](https://github.com/WecomTeam/aibot-node-sdk/issues/5)                                                                                                                                                               | 配置有界 `maxReplyQueueSize`；SDK 拒绝必须上抛，不能伪报 delivered；Outbox 有界重试/死信                         | saturation fake；retry/dead-letter tests                              | 通过       |
| 新增 frame 字段           | SDK [#22](https://github.com/WecomTeam/aibot-node-sdk/issues/22)、[#26](https://github.com/WecomTeam/aibot-node-sdk/issues/26)                                                                                               | 已知字段保持；未知字段忽略；未知消息/事件只产生有界类型诊断，不创建空 Agent turn                                 | JSON fixtures：forward fields、unknown message/event                  | 通过       |
| 控制字符与异常名称        | SDK [#15](https://github.com/WecomTeam/aibot-node-sdk/issues/15)                                                                                                                                                             | 诊断 type 只允许短 ASCII token；媒体文件名去控制字符、去目录并受长度限制                                         | Transport normalization/media tests                                   | 通过       |
| 连续 file/image/text 消息 | 官方插件 [#154](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/154)、[#165](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/165)、[#166](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/166) | 同 account+conversation 从 admission、媒体物化到 Kernel 完成严格串行；不同会话仍可并行                           | slow file → image → text；失败后 following text                       | 通过       |
| 原生 video callback       | SDK `VideoMessage` / `message.video`                                                                                                                                                                                         | 保留独立 video；不依赖 filename；SDK 下载解密；能力不匹配时 Kernel 零调用、明确终态并清理                        | 官方形状 JSON fixture；MIME/权限/清理和 queue recovery                | 自动化通过 |
| 重复入站 frame            | 官方插件连续消息问题簇                                                                                                                                                                                                       | `message.id` 在持久 Store 接收时幂等；重复 frame 不产生第二个 Kernel turn                                        | duplicate inbound tests                                               | 通过       |
| final 状态残留/重复       | 官方插件 [#155](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/155)                                                                                                                                               | 每个 run 显式 final；旧 partial 被同 stream supersede；失败只重试最新 final                                      | stream final、supersede、retry tests                                  | 通过       |
| 图片/文件重复发送         | 官方插件 [#146](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/146)、[#150](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/150)                                                                        | 媒体输出先进入耐久 artifact/Outbox；已完成 delivery 不重新 claim，失败复用同 artifact                            | media spool retry/restart/integrity tests                             | 通过       |
| 宿主 Axios/代理污染       | 官方插件 [#169](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/169)                                                                                                                                               | Kernel Adapter 在子进程，不能修改 Transport 的 JS 全局；Gateway 不修改 Axios defaults。部署代理/TLS 仍需真实矩阵 | 包边界与受限 Adapter 环境已验证；真实 HTTP 代理下载待验收             | 部分通过   |
| CLI 能力授权独立失效      | CLI [#134](https://github.com/WecomTeam/wecom-cli/issues/134)                                                                                                                                                                | 识别 `850003` / 明确过期诊断；单次失败、不自动重放写操作；只返回稳定重授权提示；写工具默认关闭                   | Tool 单次调用、脱敏结果与无重试测试                                   | 自动化通过 |

测试中的 fake 只模拟上游时序和错误合同，不伪造 WebSocket 鉴权、心跳或 AES 实现；这些继续完全交给官方
SDK。真实客户端证据与 deterministic fixture 必须同时保留，二者不能互相替代。

## 真实沙箱结果（2026-09-01 至 2026-09-04）

| 会话     | Adapter / 场景               | Channel ACK | Kernel 首文本 | 完成    | 投递状态                   |
| -------- | ---------------------------- | ----------- | ------------- | ------- | -------------------------- |
| 授权私聊 | Pi / GLM-4.6V，严格短文本    | 463ms       | 10.706s       | 11.574s | pending/leased/dead 均为 0 |
| 授权群聊 | Pi / GLM-4.6V，真实富文本 @  | 500ms       | 2.893s        | 3.855s  | pending/leased/dead 均为 0 |
| 授权私聊 | 桌面 MP4(file) → Pi 能力拒绝 | 463ms       | Kernel 未启动 | 3.177s  | 清理归零；后续文本正常     |
| 授权私聊 | MP4 file → semantic video    | 未单独采样  | Kernel 未启动 | 1.196s  | 物化 373ms；清理归零       |
| 授权私聊 | 视频拒绝后的 Pi 严格短文本   | 未单独采样  | 未单独采样    | 15.208s | 单条干净回复；无协议泄漏   |
| 授权私聊 | Pi / 无人值守唯一 marker     | 479ms       | 14.269s       | 15.084s | 首次投递；验收九项全通过   |
| 授权群聊 | Pi / 无人值守真实富文本 @    | 412ms       | 3.960s        | 4.908s  | 首次投递；验收九项全通过   |

群聊 final 已被官方 SDK 接受且会话列表立即显示最终文本。2026-09-04 的无人值守真实富文本 @ 回归中，
macOS 企业微信当前打开的消息气泡曾停留在旧的“思考中”渲染；自动切换会话再返回后，同一气泡正确显示
final。这被记录为客户端重绘观察项，不归类为 Gateway 丢终态，也不把一次重绘结果外推为所有企业微信
客户端都不存在类似现象。

2026-09-03 再次通过桌面媒体选择器发送 MP4，客户端仍归类为 `msgtype=file`。该结果暴露出 wire type
直接穿透会令 Kernel 收到错误的 `file` 能力拒绝；Transport 现于受保护物化后按明确 MIME 将其归一为
语义 `video`，同时保留原始 `metadata.msgtype=file`。正式受管服务回归显示 373ms 完成物化、1.196s
明确回复“当前 Agent 不支持视频输入”；紧随文本 15.208s 完成且只有一次干净答案。临时目录与 Outbox
积压/死信均归零。这仍不能记为原生 `video` callback 通过。

## 未知 frame 的处理规则

1. 已知消息类型中新增的字段前向兼容，不进入 Runtime Contract metadata，也不写日志。
2. 未知 `msgtype` 不转换成空文本，不调用 ACL/Kernel；只记录
   `wecom_unsupported_frame` 的 `frameKind` 与有界 `type`。
3. 未知 event 同样只诊断；已知 `enter_chat`、卡片 callback、feedback 和连接断开事件不会重复诊断。
4. 诊断不得包含原 frame、用户、会话、媒体 URL、AES key 或 request ID。

## 升级步骤

1. 核对 npm `latest`、官方仓库 README/API 和相关 issue 状态，记录日期，不按 star 数判断兼容性。
2. 只更新精确 SDK 版本并重新生成锁文件，不从官方插件复制协议、鉴权、心跳或媒体实现。
3. 运行 `pnpm test:m3-upstream-compatibility` 与 `pnpm run ci`。原生媒体变更同时运行
   `pnpm test:m3-native-media`。
4. 在授权私聊和测试群各跑一轮普通文本、快速连续消息、图片/文件、流式 final；确认 Outbox
   `pending/leased/dead` 为零。
5. SDK 若改变 callback shape，先增加脱敏 JSON fixture 再修改归一化；未理解的新类型保持 fail silent to
   Kernel，而不是猜测语义。
6. 把版本、采用/规避决定、自动化结果和真实沙箱结果更新到本页与 `status.md` 后再合并。

## 当前非声明

- 真实 HTTP/HTTPS 代理下的下载、解密与自签 TLS 组合尚未完成，不声称代理矩阵通过。
- 宿主机物理网络中断与 24 小时 Linux/systemd soak 属于 M3.1。
- 原生 `msgtype=video` 的协议、物化、能力拒绝与清理已自动化通过；真实客户端 callback 仍待捕获。macOS
  企业微信 `5.0.10 (99949)` 的图片面板明确拒绝 MP4；MP4 普通 file callback 只会在解密后提升为
  Runtime 语义 video，不能替代原生 callback 证据。
- 同一 macOS 客户端在授权 Bot 私聊里对用户/Bot 文本均未暴露引用入口，引用 callback 的真实客户端
  证明仍待上游入口或其他官方客户端。
- macOS 企业微信对同一条流式消息的气泡重绘可能短暂落后于会话列表；目前没有协议级送达回执可证明终端已
  完成视觉重绘，验收需同时核对 SDK 结果、Outbox、会话列表和重新进入会话后的气泡终态。
