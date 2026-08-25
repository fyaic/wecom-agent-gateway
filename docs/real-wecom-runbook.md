# 真实企业微信联调手册

更新于 2026-08-25。本文只覆盖独立测试 Bot，不使用真人账号模拟 Bot，也不从
`wecom-cli` 的加密凭据存储中导出 Secret。

## 授权边界

- 只配置专门用于验收的成员私聊和测试群聊；真实名称仅保存在本机 `.env`。
- 其他私聊、群聊和外部联系场景全部 fail closed。
- 办公工具可逐步接入；读取按请求执行，写入/删除继续保留审计、确认和所有权约束。

私聊授权写入 `WECOM_ALLOWED_DIRECT_SENDERS`，群聊授权写入
`WECOM_ALLOWED_GROUP_CONVERSATIONS`。不要把授权人放进旧的
`WECOM_ALLOWED_SENDERS`：其语义是“该用户从任何会话都可访问”，会超过当前授权范围。

## Kernel Adapter 选择

`GATEWAY_ADAPTER` 明确选择当前进程唯一的 Kernel：`codex`、`kimi`、通用 `acp`、`openclaw` 或 `pi`。Kimi 使用
`KIMI_EXECUTABLE` 指向已有登录状态的 CLI，并由 Gateway 启动 `kimi acp`；通用 ACP 使用
`ACP_ADAPTER_ID`、`ACP_EXECUTABLE` 和 JSON 数组 `ACP_ARGS_JSON`。不要同时启动两个 Kernel，也不
允许模型按自然语言选择 Kernel。

切换到 Kimi 前先运行不经过企业微信的两轮 smoke：

```bash
pnpm smoke:kimi-adapter --confirm-real-kimi
```

成功输出只包含 Adapter、协议、流式/恢复/多模态布尔值和总耗时，不输出 session ID。ACP child
默认不继承 Bot secret；第三方 provider 确需额外环境变量时，只能把变量名加入
`ACP_AGENT_ENV_ALLOWLIST`，不得把值写入仓库。

Pi 使用官方 `pi --mode rpc`。先在 Pi 自身完成 provider/模型配置，再执行不经过企业微信的两轮 smoke：

```bash
GATEWAY_ADAPTER=pi pnpm doctor:live
GATEWAY_ADAPTER=pi pnpm smoke:pi-adapter --confirm-real-pi
```

Pi 子进程默认不继承 Bot secret 或 Gateway 配置；确需 provider 环境变量时，只把变量名加入
`PI_AGENT_ENV_ALLOWLIST`。当前实现默认使用两个长期 Pi RPC worker；`PI_MAX_WORKERS` 可调但必须
保持有界。同一 opaque session 由 keyed lock 串行，不同 session 可并行。Pi
`0.84.2` 已按官方 `npm --ignore-scripts` 方式安装，真实 RPC Doctor 9/9 通过。经本机授权，Pi 自己的
私有 `auth.json` 管理 ZAI 凭据，仓库、Gateway `.env`、进程参数和普通日志均不保存 Key。

同日 `zai/glm-5.2` 真实两轮 RPC smoke 通过：首轮 6.745 秒，恢复轮 3.595 秒，总计 10.93 秒。
企业微信私聊前两轮也通过：回执分别为 400/385ms，首文本 3.919/2.638 秒，端到端 4.610/3.382 秒。
随后重启 Gateway/Pi 子进程并重新鉴权，连续两轮仍正确恢复原 session：回执 432/392ms，首文本
3.475/3.992 秒，端到端 4.885/4.833 秒。数据库始终只有一个 Pi 私聊 session，Outbox 81 条全部
delivered、无 pending/dead。

并发容量可用真实模型 smoke 单独验证，不经过企业微信：

```bash
PI_MAX_WORKERS=2 pnpm smoke:pi-pool --confirm-real-pi
```

2026-08-24 两个独立 session 分别耗时 6.373/6.876 秒，总墙钟 6.877 秒，确认真实重叠而非
全局串行。测试不输出 session ID 或回复正文。

Pi 当前模型目录明确标记 `zai/glm-5.2` 为 `images=no`，所以 Adapter 动态关闭
`multimodal-input`。这不是 WeCom 媒体链路缺陷；Pi 图片验收必须切换到真实声明 image input 的模型，
不能把图片转成文字占位，也不能虚报 capability。

视觉验收使用独立自定义 provider `zai-vision/glm-4.6v`，配置模板见
[`deploy/pi/models.zai-vision.example.json`](../deploy/pi/models.zai-vision.example.json)。模型清单声明
`input=["text","image"]`，provider Key 仍只在 Pi 权限为 `0600` 的私有 auth 中。先用内容已知的图片
验证模型、Pi RPC 与 Adapter，不经过企业微信：

```bash
PI_ARGS_JSON='["--provider","zai-vision","--model","glm-4.6v"]' \
PI_SMOKE_IMAGE_PATH=/absolute/path/to/image.png \
PI_SMOKE_EXPECT='图片中必须出现的文字' \
pnpm smoke:pi-image-adapter --confirm-real-pi
```

2026-08-24 本机 smoke 已动态协商 `multimodal-input`，GLM-4.6V 正确识别真实截图中的目标文字，
总耗时 8.215 秒。脚本只输出能力、布尔匹配结果和耗时，不输出模型回复、图片内容或 session ID。
企业微信首次纯图片验收暴露出 GLM-4.6V 兼容端点在 `prompt.message=""` 时会以缺失
`finish_reason` 结束；同一图片加单个空格即成功。Adapter 因此只为纯图片加入无语义的 wire padding，
不加入图片描述指令。失败 session 应隔离后重新验收，避免 provider error 污染后续上下文。

修复后同一授权私聊的纯图片端到端验收通过：Channel 回执 397ms，官方 SDK 下载、解密和临时物化
314ms，Pi/GLM-4.6V 首文本 10.812 秒，端到端完成 15.414 秒。Gateway 创建一个干净 Pi session，
Outbox 123 条全部 delivered，媒体临时目录残留为零。紧随图片到达的下一条文本保持同会话串行，
因等待前一轮与模型长响应总计 84.304 秒；该数据单独记为队列/模型性能问题，不影响纯图片链路结论。

2026-08-24 已完成真实 Kimi ACP 验收：本机两轮 smoke 为 13.0 秒；企业微信私聊文本的 Channel
回执 418ms、Kimi 首文本 5.68 秒、端到端 6.42 秒。随后在同一私聊发送图片，数据库仍只有一个
Kimi 会话映射，SDK 媒体物化 356ms、Kimi 首文本 10.97 秒、端到端 13.23 秒；Outbox 全部 delivered，
临时媒体目录残留为零。该结果证明第二真实 Kernel、session 恢复和图片输入闭环。

OpenClaw 模式连接一个独立运行的 loopback Gateway，不要求 Codex 登录，也不接收模型 API Key。
OpenClaw Gateway 的 token/password 应由操作系统凭据存储或进程管理器注入当前进程。先执行：

```bash
GATEWAY_ADAPTER=openclaw pnpm doctor:live
GATEWAY_ADAPTER=openclaw pnpm smoke:openclaw-adapter
```

2026-08-24 已使用本机既有 OpenClaw 与 `zai/glm-5.2` 完成两轮真实 smoke：严格回复均正确，首轮
8.2 秒、同 session 续接轮 6.4 秒。首次联调发现模型已完成但稳定版 Gateway 的终态事件未送达
测试版官方客户端；Adapter 已加入 `agent.wait + chat.history` 对账，保留实时流式并避免永久等待。
模型与 Gateway 凭据均未写入项目文件或测试输出。企业微信端到端验收见下表及后续记录。

同日已完成首条企业微信私聊端到端验收：Channel 回执 405ms，GLM 首文本 12.09 秒，端到端
15.13 秒；期间多次 Bot 可变消息更新全部成功。SQLite 建立了独立 OpenClaw session 分区，Outbox
全部 delivered、无 pending/dead。该验证沿用同一 Bot、ACL、Store 和 WeCom Transport，仅替换
Kernel Adapter。

随后在同一私聊询问上一条消息，OpenClaw session 分区数量仍为 1；Channel 回执 446ms、首文本
8.46 秒、端到端 9.98 秒，回答正确。Outbox 继续全部 delivered，确认企业微信会话到 OpenClaw
session 的恢复映射有效。

同一 session 的图片验收也已通过：Channel 回执 405ms，官方 SDK 下载/解密并物化耗时 2.85 秒，
GLM 首文本 46.48 秒，端到端 50.89 秒；临时媒体目录清零，数据库未出现下载 URL、AES key 或临时
路径，Outbox 仍全部 delivered。图片的主要耗时位于 OpenClaw/模型执行段，不是 WeCom 接入、ACL、
排队或媒体下载段；Gateway 不通过改写 Prompt 或擅自切换模型掩盖该延迟。

授权测试群的真实 `@Bot` 也已通过：group-only ACL 放行，Channel 回执 874ms，
GLM 首文本 23.05 秒，端到端 25.20 秒，多次可变回复投递成功。OpenClaw session 总数为 2，恰好
分别对应授权私聊和群聊；Outbox 64 条全部 delivered。

## 一次性准备

1. 在企业微信管理侧确认保留的正式测试 Bot 已启用长连接模式；若凭据曾出现在非凭据存储中，先由管理员亲手轮换 Secret。
2. 把 Bot 加入专用测试群，由群成员在群内 `@Bot` 发送一条测试消息。
3. 只在本机编辑被 Git 忽略的 `.env`，填入：

   ```dotenv
   WECOM_BOT_ID=
   WECOM_BOT_SECRET=
   CODEX_ADAPTER=app-server
   CODEX_REASONING_EFFORT=low
   CODEX_RESPONSES_WEBSOCKET=false
   WECOM_MEDIA_MAX_BYTES=52428800
   WECOM_MEDIA_RETENTION_MS=86400000
   WECOM_MEDIA_OUTPUT_ROOTS=/仅允许Agent外发文件的绝对目录
   GATEWAY_OUTBOX_POLL_INTERVAL_MS=1000
   GATEWAY_OUTBOX_LEASE_MS=30000
   GATEWAY_OUTBOX_MAX_ATTEMPTS=5
   GATEWAY_OUTBOX_RETRY_BASE_MS=1000
   GATEWAY_OUTBOX_RETRY_MAX_MS=30000
   GATEWAY_OUTBOX_BATCH_SIZE=10
   GATEWAY_MAX_PENDING_INBOUND_MESSAGES=100
   GATEWAY_MAX_PENDING_INBOUND_PER_CONVERSATION=10
   GATEWAY_MAX_CONCURRENT_RUNS=8
   GATEWAY_APPROVAL_TIMEOUT_MS=300000
   CODEX_APPROVAL_WAIT_TIMEOUT_MS=90000
   GATEWAY_MEDIA_SPOOL_ROOT=data/media-spool
   GATEWAY_MEDIA_SPOOL_MAX_TOTAL_BYTES=524288000
   ```

4. 由脚本从当前授权身份和最新 Bot 会话列表生成精确 allowlist：

   ```bash
   pnpm configure:allowlist --direct '授权测试成员' --group '授权测试群'
   ```

5. 首次部署时运行私聊挑战注册，按终端给出的一次性口令从目标私聊发送；注册成功后脚本自动退出：

   ```bash
   pnpm enroll:direct --name '授权测试成员'
   ```

6. 再运行一次 `configure:allowlist`。返回 `ready: true` 才表示两个授权会话都已解析；所有脚本均不打印内部会话或用户 ID。

`.env` 会被设为 `0600`。
Gateway 数据目录应为 `0700`；SQLite Store 每次打开主数据库时会强制收紧为 `0600`。

## 联调顺序与通过条件

| 顺序 | 场景                | 通过条件                                                     |
| ---- | ------------------- | ------------------------------------------------------------ |
| 1    | WebSocket 鉴权      | 官方 SDK 触发 authenticated，进程保持在线                    |
| 2    | 私聊文本            | Bot 收到消息，所选 Kernel 产生回复，企业微信完成最终流式消息 |
| 3    | 群聊 `@Bot` 文本    | 仅授权群进入 Agent；其他群被策略层拒绝                       |
| 4    | 主动推送            | 私聊和授权群均可发送；其他目标不进入发送链路                 |
| 5    | 多轮与重启恢复      | 同一会话复用 runtime session，进程重启后仍能恢复             |
| 6    | 流式窗口过期        | 官方错误码 `846608` 时只把最终文本降级为主动推送             |
| 7    | 图片/语音/视频/文件 | 下载、解密、Agent 输入、上传与发送分别有大小和类型约束       |
| 8    | 断网与重连          | SDK 自动心跳/重连后恢复收发，不重复处理已经接受的入站消息    |

## Gateway 原生主动消息

主动控制面默认关闭。它允许本地 Agent、定时任务或自动化按别名向既有授权会话发送消息，但客户端不读取
`.env`，也不接触 Bot Secret、内部会话 ID 或 SQLite。先在 Gateway 的私有 `.env` 中启用：

```dotenv
GATEWAY_CONTROL_ENABLED=true
GATEWAY_CONTROL_SOCKET=data/gateway-control.sock
```

当 direct-only 和 group-only allowlist 各只有一个条目时，Gateway 自动创建 `direct` 和 `group`
别名。启动后检查 socket，再分别发送无副作用文本：

```bash
pnpm proactive:health
pnpm proactive:send --target direct --text 'Gateway 主动私聊验收。'
pnpm proactive:send --target group --text 'Gateway 主动群聊验收。'
```

成功输出只包含 text/media、direct/group 和 `delivered`/`queued`，不包含目标 ID 或正文。`queued`
表示命令已持久化并等待 Outbox 重试，不等于丢失。媒体使用同一入口：

```bash
pnpm proactive:send --target direct \
  --file /仅允许Agent外发目录/test.png \
  --media-type image
```

文件必须位于 `WECOM_MEDIA_OUTPUT_ROOTS`，随后仍由 Gateway spool、校验和官方 SDK 发送。多目标时在
私有 `GATEWAY_PROACTIVE_TARGETS_JSON` 中配置别名；任一目标不在对应 scoped allowlist 都会使 Doctor
和 Gateway 启动失败。socket 权限必须为 `0600`，停机后应被删除。

2026-08-24 已在受管 Pi Gateway 上启用该控制面：Doctor 10/10，通过强制重启后 Bot 重新鉴权，socket
权限为 `0600`，health 成功且只生成 `direct` / `group` 两个目标。两条主动文本并发提交后官方 SDK
均返回 `delivered`；Outbox 累计 144 条 delivered、无 pending/leased/dead。命令输出没有正文、Bot
Secret 或内部目标 ID。随后通过同一控制面发送允许根目录内的小型文件，官方 SDK 返回 `delivered`，
Outbox 增至 145 条 delivered 且临时 spool 归零。随后重发带明确验收标识的私聊文本、群聊文本和
私聊文件，三项均由授权用户确认客户端可见；Outbox 累计 148 条 delivered、无
pending/leased/dead，状态由 SDK 接受升级为完整通过。

图片真实验收时，向授权私聊发送普通图片或“文字 + 图片”混合消息。通过条件：日志出现
`media-materialized` 且无 URL/AES key；Codex 能基于原图回答；run 完成后系统临时目录中不存在
`wecom-agent-gateway-media-*` 残留。不要把真实下载 URL、AES key 或本地路径复制进测试记录。

2026-08-20 已完成一次真实“文字 + 图片”私聊：企业微信把两部分作为相邻回调送达，Gateway
保持同会话顺序；官方 SDK 明确记录下载和 AES 解密成功，Codex 原生图片 turn 完成，随后检查
系统临时目录残留为 0。当时尚未执行的文件/视频矩阵已在下述 2026-08-24 记录中补齐。

2026-08-24 已补充真实文件和 MP4 验收。普通文件经官方 SDK 回调、下载/解密、受保护物化并交给
OpenClaw：Channel 回执 441ms、物化 2.317 秒、首文本 7.786 秒、端到端 12.131 秒。MP4 经企业微信
桌面端发送后被归一化为普通 `file` 回调，Gateway 仍完成二进制交付：回执 446ms、物化 1.147 秒、
首文本 34.394 秒、端到端 37.510 秒。Agent 回复已收到视频但没有视频抽帧/执行工具，这是 Kernel
能力边界，不是 Channel 失败。两次验收后 Outbox 无 pending/dead，临时媒体目录归零。原生
`msgtype=video` 的真实客户端回调尚未捕获，但官方 video/file frame 归一化和 MP4 物化已有
deterministic contract 覆盖，不能把桌面端的消息分类方式误记为 Gateway 缺陷。

同日已完成一次真实图片主动发送：测试图片位于一次性显式允许根目录，正式 Bot 通过官方 SDK
完成 `uploadMedia` 和 `sendMediaMessage`，只发送到授权私聊；测试输出不包含目标内部 ID、
media_id 或凭据。生产环境必须把 `WECOM_MEDIA_OUTPUT_ROOTS` 收窄到专用产物目录，不能配置
工作区根、用户目录或 `/`。

2026-08-21 已运行媒体 outbox 真实 smoke：artifact 提交 SQLite 后删除原始测试文件，关闭并重建
Store/Spool/Gateway，再由官方 SDK 上传并发送到唯一授权私聊，SDK 返回接受，授权用户随后确认
客户端可见。脚本不输出内部目标、artifact/media ID 或凭据。

所有测试记录只保存会话类型、时间、结果与脱敏错误，不保存消息正文、内部 ID 或凭据。

2026-08-20 已完成私聊、真实群聊 `@Bot`、连续多轮和进程重启恢复。首轮群聊曾在
Codex 长耗时接近流式窗口时出现客户端末字截断；设置低推理强度并在调用 runtime 前先建立
流式首帧后，私聊与群聊最终完整文本均通过。持久 App Server 的 HTTP-only 真实私聊复测为：
Channel 首回执 452ms、Kernel 首文本 3.88s、端到端完成 5.12s，用户端确认延迟明显改善。

## macOS 受管 OpenClaw 服务

仓库提供 [`deploy/macos/com.fyaic.wecom-agent-gateway.openclaw.plist.example`](../deploy/macos/com.fyaic.wecom-agent-gateway.openclaw.plist.example)。
部署时把占位符替换为项目目录、`pnpm` 绝对路径、loopback Gateway URL、日志路径和钥匙串条目名称，
再安装到用户 `LaunchAgents`。plist 只保存钥匙串定位信息，启动 shell 在当前进程中读取 token 后
立即 `exec pnpm start:checked`；token 不进入 plist、`.env`、Git 或日志。

```bash
plutil -lint ~/Library/LaunchAgents/com.fyaic.wecom-agent-gateway.openclaw.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.fyaic.wecom-agent-gateway.openclaw.plist
launchctl kickstart -k "gui/$(id -u)/com.fyaic.wecom-agent-gateway.openclaw"
```

切换或维护前先停止该单实例，避免两个进程同时消费 Bot WebSocket：

```bash
launchctl bootout "gui/$(id -u)/com.fyaic.wecom-agent-gateway.openclaw"
```

## macOS 受管 Pi 服务

仓库同时提供 [`deploy/macos/com.fyaic.wecom-agent-gateway.pi.plist.example`](../deploy/macos/com.fyaic.wecom-agent-gateway.pi.plist.example)。
它只保存 Pi 可执行路径、模型 argv 和日志路径；provider Key 仍由权限为 `0600` 的 Pi
`~/.pi/agent/auth.json` 管理，不写入 plist、`.env` 或仓库。

同一 Bot 任一时刻只能运行一个 Gateway Kernel。安装 Pi LaunchAgent 前必须 `bootout` OpenClaw
服务，并把其 plist 移出 `~/Library/LaunchAgents/*.plist` 自动加载范围；切回 OpenClaw 时执行相反
操作。不要同时保留两个 `RunAtLoad + KeepAlive` plist。

```bash
plutil -lint ~/Library/LaunchAgents/com.fyaic.wecom-agent-gateway.pi.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.fyaic.wecom-agent-gateway.pi.plist
launchctl kickstart -k "gui/$(id -u)/com.fyaic.wecom-agent-gateway.pi"
launchctl bootout "gui/$(id -u)/com.fyaic.wecom-agent-gateway.pi"
```

2026-08-24 已安装并验证该 Pi LaunchAgent：`start:checked` 8/8，首次启动与强制受管重启后均完成
Pi Adapter ready 和 Bot WebSocket 重新鉴权；重启前后均维持 2 个长期 Pi worker。旧 OpenClaw plist
以 `.disabled` 保留在本机，避免下次
登录自动并发启动；切回时必须先 bootout Pi，再恢复旧 plist 文件名。

2026-08-25 再执行一次真实 `SIGKILL`：受管 Gateway PID 发生更替，LaunchAgent 自动拉起新进程，
Pi Adapter 重新进入 ready，官方企业微信传输重新进入 authenticated。随后独立复核 `readyz`、本地
主动控制面均为 ready；Outbox 保持 148 delivered、0 pending/leased/dead，没有额外发送测试消息。
这证明进程管理与 SDK 重鉴权恢复，不等于物理断网验收。

同日将唯一 Bot 临时切换到隔离 Linux 容器，并使用确定性外部 Adapter 避免引入模型因素。官方 SDK
先完成 authenticated；移除容器 network namespace 的唯一网络后，SDK 心跳确认 disconnected，
`readyz` 降级而进程继续存活，并按 1/2/4/8/16 秒退避。恢复网络后 SDK 自动 authenticated，
`readyz` 恢复。没有发送验收消息，正式受管 Pi Gateway 在容器接管前已停止，测试结束后恢复为
ready；正式 Outbox 仍为 148 delivered、0 pending/leased/dead。

隔离容器还完成两类真实存储故障：已有 SQLite 卷改为只读后以 `EROFS` fail closed，恢复读写挂载后
重新鉴权并 ready；无网络 2MB tmpfs 在 42 条已提交 Outbox 记录后触发容量耗尽，释放预留恢复空间后
数据库重新打开且已提交记录全部可读。首次容量测试发现回滚二次错误会覆盖原始磁盘已满错误，Store
已改为始终保留因果错误并加入回归测试。以上不等同于真实 systemd soak 或宿主机物理网卡中断。

OpenClaw Gateway 也必须由自己的服务管理器持续运行。若它尚未就绪，LaunchAgent 会按节流间隔重启；
Gateway Adapter 只有 ready 后才开放企业微信入站。

2026-08-24 本机已安装该 LaunchAgent：`start:checked` 9 项检查全部通过，Adapter ready 后企业微信
重新鉴权成功。随后执行一次 `kickstart -k`，进程发生更替并再次以 OpenClaw 配置完成检查、连接和
鉴权；没有退回 `.env` 中的其他 Adapter，也没有把 token 写入 plist 或日志。

## 启动与停止

```bash
pnpm dev
```

使用 `Ctrl-C` 正常停止，Gateway 会等待当前会话队列完成、断开官方 SDK，并关闭 SQLite。

文本命令会在实际发送前进入 SQLite outbox。发送失败不会让 Channel 假装 Agent 失败，也不会
阻塞 Agent 继续生成最终版本；后台 worker 会重试，最终版本可替代尚未发送的旧 partial。默认
30 秒租约、最多 5 次指数退避。只检查聚合状态，不读取消息正文或内部目标：

```sql
SELECT status, count(*) FROM delivery_outbox GROUP BY status;
```

正常运维优先使用不显示正文、目标或内部 ID 的封装命令：

```bash
pnpm outbox:status
```

出现 `dead` 时应先检查脱敏后的 `infrastructure_error` 与 `delivery_lifecycle` 日志，再决定是否
人工重放。禁止直接修改生产 SQLite；只使用下文带确认门的受限重排命令。

媒体发送会先从 `WECOM_MEDIA_OUTPUT_ROOTS` 复制到 `GATEWAY_MEDIA_SPOOL_ROOT`，再进入 outbox。
前者是 Agent 产物的只读来源，后者必须是 Gateway 专用目录；两者不要配置成同一路径，也不要把
spool 放入 Agent 可写工作区。数据库只保存 artifact ID、大小和哈希。成功或死信后删除 artifact；
重启时根据 SQLite 活跃引用清理 staging 和无引用 artifact。总配额默认 500MB，满额时 fail closed。

需要重排死信文本时，先停止造成失败的根因并再次查看聚合状态。以下命令只重排最终回复和主动
文本，默认 10 条、最大 100 条；不会重排 partial 或媒体。运行中的 Gateway 会在下一轮认领后
产生真实外发，因此必须由操作员明确授权：

```bash
pnpm outbox:replay-text --confirm-requeue-terminal-text --limit=10
```

默认 `CODEX_ADAPTER=app-server`，Gateway 启动时建立一个常驻 Codex App Server 进程，并在
SQLite 保存企业微信会话到 Codex thread 的 opaque 映射。它不会发送预热消息或注入提示。
`CODEX_ADAPTER=sdk` 仅保留为旧实现对照。

### 可选：启用只读 Codex 动态工具

默认不开启工具。当前仅开放固定联系人搜索，不接受任意 `wecom-cli` argv：

```dotenv
WECOM_CLI_TOOLS_ENABLED=true
WECOM_CLI_WRITE_TOOLS_ENABLED=false
WECOM_CLI_EXECUTABLE=wecom-cli
WECOM_CLI_CONFIG_DIR=/absolute/path/to/wecom-cli-config
```

启用前先确认 `wecom-cli --version` 不低于 `1.1.0` 且 `wecom-cli auth show --status` 为
`authorized`。可用以下命令验证 Codex App Server → 动态工具 → CLI 本机闭环：

```bash
pnpm smoke:codex-tool --confirm-readonly-contact-search
```

成功只输出聚合结果，不输出联系人内部 ID。已有 Codex thread 的动态工具 catalog 由 App Server
持久化；Adapter 以 catalog 哈希隔离 session，工具集合变化后的首次消息自动创建兼容的新 thread，
旧记录不删除。`WECOM_CLI_WRITE_TOOLS_ENABLED=false` 时只注册联系人搜索；设为 `true` 才额外注册
审批必需的单条待办创建。不能通过调高 Codex sandbox 或 approval policy 绕过 Gateway 的工具
副作用声明与审批要求。

### 审批控制命令

当启用一个明确标记为 `approval=required` 的写工具时，原可变回复只显示等待状态，Bot 另发一条
独立审批消息，其中包含：

```text
/approve ABCD1234
/deny ABCD1234
```

独立审批消息不会被 Agent 的思考、工具状态或最终文本覆盖。只能原请求所在会话中的原发送者执行，
且命令必须完整、单独发送；自然语言“同意”不会被 Channel
解释为审批。Gateway 策略上限由 `GATEWAY_APPROVAL_TIMEOUT_MS` 控制，Codex 还受
`CODEX_APPROVAL_WAIT_TIMEOUT_MS` 限制，实际取较短值，默认 90 秒。重复、跨会话、跨发送者或过期
命令不会执行工具。Gateway 正常停止、意外重启或 Kernel turn 先结束后，旧的待审批操作统一中断，
必须由用户重新发起原业务请求。

没有待处理请求时直接发送上述命令只会得到“审批不存在/已处理”的安全回复。首次真实审批联调
使用独立开关启用 `wecom_todo_create`，限定在已授权测试私聊或测试群，并分别验证批准、拒绝、
超时和重启中断；创建的测试待办验收后删除，测试
记录不得保存审批码、工具参数或内部 ID。

2026-08-24 的授权私聊实测中，独立 `proactive` 审批消息一次投递成功，17.4 秒后由原会话原发送者
批准；`wecom_todo_create` 仅出现一次 `started` 并在 1.4 秒后 `succeeded`，整轮从入队到完成为
29.9 秒，Outbox 无待处理或死信。随后通过唯一测试标题确认恰好一条待办，删除成功并复查为零。
该记录证明批准路径、恰好一次观察结果和清理已通过；拒绝与进程重启中断仍需分别做真实验收。

当前网络中 Codex Responses WebSocket 首轮会耗尽重试预算后才回退 HTTP，因此默认
`CODEX_RESPONSES_WEBSOCKET=false`：adapter 使用 ChatGPT 登录兼容的 HTTP-only provider。
如果部署网络已经确认可稳定连接 Responses WebSocket，可设为 `true` 使用内置 provider。
其他可选项见 `.env.example`，其中 sandbox 默认只读、approval 默认拒绝。

不经过企业微信的 adapter 分层基准：

```bash
pnpm benchmark:codex-app-server
```

该命令创建独立测试 thread，连续执行两个只返回 `OK` 的文本回合，不写工作区，也不复用正式
企业微信 session。它用于区分 adapter/Kernel 延迟与企业微信 transport 延迟。

媒体 outbox 的真实恢复 smoke 必须带显式确认门，且 scoped direct allowlist 必须恰好一个目标：

```bash
pnpm smoke:media-outbox --confirm-send-to-authorized-direct
```

脚本创建隔离的临时 SQLite/spool，提交 artifact 后删除原文件并重建 Gateway，再发送一个小型文本
附件；结束后删除临时目录。它不触发 Agent turn，不复用正式 Gateway 数据库，也不打印内部 ID。

## 故障分界

- 群聊不在 `sessions list`：Bot 尚未被加入，或加入后尚未被 `@` 触发；不能手填或复用
  历史群 ID 绕过。
- `Missing WECOM_BOT_*`：独立 Gateway 凭据未在本机填写；wecom-cli 已授权不等于其他
  进程可以读取其加密 Secret。
- WebSocket 未 authenticated：检查管理侧长连接模式、Bot ID/Secret 和网络。
- 已鉴权但无回复：依次检查 conversation allowlist、入站去重、runtime adapter 和投递日志。
- Channel 首回执亚秒但首文本约 1–2 分钟，且 stderr 出现 5 次 sampling WebSocket timeout：确认 `CODEX_RESPONSES_WEBSOCKET=false`，再运行 adapter 基准；这不是企业微信 WebSocket 鉴权链路。
- 已显示中性接收回执但最终文本接近流式窗口：窗口过期时由主动推送降级保证最终结果可达；不要让 Channel 伪造“思考中”等 Agent 状态。
- `delivery_lifecycle=retry-scheduled`：transport 本次发送失败，命令已安全回到 pending；检查网络和官方 SDK 状态，不要重复触发 Agent turn。
- `delivery_lifecycle=dead-lettered`：已达到最大尝试次数；消息不会自动继续发送，保留数据库并按事件时间排查。
- `gateway_backpressure`：消息在持久化和 Agent turn 前被容量边界拒绝；事件不含内部 ID。检查 run 延迟、待处理量和下游健康，不要直接无限调高上限。
- `approval_lifecycle=expired/interrupted`：写工具未执行。前者表示超过审批窗口，后者通常表示 Gateway 停机、重启或审批存储故障；让用户重新发起，不要手改 SQLite 状态。
- Agent 回复“工具/服务长时间无响应”，但日志只有 `approval_lifecycle=requested/expired`、没有
  `runtime_tool_lifecycle=started`：工具服务并未执行。这表示审批未在 Kernel 截止时间内完成；不要
  重试 CLI 或排查待办 API，先确认用户是否看见并及时发送了精确审批命令。
- 审批提示出现后立即消失：这是把审批码写入可变 Agent 回复的旧版本缺陷。当前版本应另发独立
  `proactive` 控制消息；若仍复现，检查 Outbox 中该主动消息是否 delivered，禁止延长超时掩盖问题。
- `media-spool/materialize` 完整性错误：spool 文件在 stage 后发生变化；不要绕过哈希校验，应检查目录权限和同机进程。
