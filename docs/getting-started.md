# 从零到第一条企业微信回复

[English](getting-started.en.md) · [日常使用场景](use-cases.md)

目标不是先理解整个仓库，而是先区分三个问题：Gateway 链路能否工作、Agent 能否独立回答、真实 Bot 能否收发。

## 1. 无账号演示

准备 Node.js 22.13+ 和 pnpm 11.8.0。当前面向 macOS / Linux，从源码运行，尚无 npm 一键安装包。

```bash
git clone https://github.com/fyaic/wecom-agent-gateway.git
cd wecom-agent-gateway
pnpm install --frozen-lockfile
pnpm demo
```

预期出现六项通过：回复、去重、拒绝未授权用户、重建 Gateway 后恢复会话、主动消息、Outbox 排空。
这里运行真实 Core / SQLite / 外部 Adapter 加载器，但使用本地 Loopback 和确定性 Echo。
**没有连接企业微信，也没有调用模型。** 无需复制生产配置或运行整套开发者 CI。

## 2. 选择已有 Agent

先选一个已经能在本机正常回答的 Agent，而不是先购买另一个模型账号。

```bash
pnpm onboard --adapter pi
```

可选值为 `codex | kimi | pi | openclaw | echo`。命令创建权限为 `0600` 的最小 `.env`；
已有配置或同名符号链接会被拒绝，绝不覆盖。默认创建被 Git 忽略的 `agent-workspace/`。
希望 CLI Agent 读取已有项目时，在首次生成时指定：

```bash
pnpm onboard --adapter codex --workspace /path/to/project
```

已有 `.env` 时直接编辑 Adapter 和对应配置。完整选项见 [.env.example](../.env.example)，不必全部复制。

| Agent                     | 需要你已有的环境                         | 最小额外配置 / 边界                                                     |
| ------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| Codex                     | 已安装并登录的 `codex`                   | 生成器选 App Server、read-only、never approval；不是当前 Codex 桌面任务 |
| Kimi Code                 | 已登录且能启动 `kimi acp`                | `KIMI_EXECUTABLE=kimi`；模型与凭据由 Kimi 管理                          |
| Pi                        | `pi` 已有有效 provider/model 和认证      | 默认复用本机 Pi 配置；可显式指定下列参数                                |
| OpenClaw                  | 本地 Gateway 已启动，目标 Agent 已能回答 | 必填本地 Gateway token 或 password；不会自动提取配置                    |
| Echo                      | 无 Agent / 模型                          | 只原样回显，验证真实 Bot 链路；不是 AI                                  |
| 通用 ACP / 自定义 harness | 已知协议和可执行程序                     | 不在生成器里猜测，按 [Adapter 指南](adapter-authoring.md) 配置与验证    |

Pi 可选配置（替换为你实际可用的 provider/model）：

```dotenv
PI_ARGS_JSON='["--provider","your-provider","--model","your-model"]'
```

如依赖环境变量形式的模型 Key，需在本地设置该变量，并在 `PI_AGENT_ENV_ALLOWLIST` 中显式列出变量名。
Gateway 不会自动把所有宿主环境变量传给 Agent。不要提交 Key。

OpenClaw：

```dotenv
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=
# 或 OPENCLAW_GATEWAY_PASSWORD；填写已有本地 Gateway 的值
OPENCLAW_AGENT_ID=
```

OpenClaw 的工作区由其自身配置管理，`AGENT_WORKING_DIRECTORY` 不会替它切换工作区。
Claude Code 目前仍为实验包，不能在此写一个 `GATEWAY_ADAPTER=claude` 就使用。

### 可选：先验证真实 Agent

```bash
pnpm agent:check
```

会真实调用所选 Agent 两轮，第二轮不重复首轮口令，验证记忆与 session 连续性。
使用该 Agent 已配置账号的额度；不会连接 Bot、不会使用生产会话数据库，但 Agent 自己可能保留测试会话。
只输出通过状态、流式观察与耗时，不打印会话正文或内部 ID。Echo 不会通过此 AI 语义检查。
检查限时两分钟，随后尝试停止 Adapter；认证、额度、超时与回答不符合检查要求会分别给出脱敏错误码。

## 3. 填写 Bot 并授权私聊

在企业微信创建或选择 **API 模式、长连接**智能机器人，取得 Bot ID 与 Secret，填写到 `.env`：

```dotenv
WECOM_BOT_ID=
WECOM_BOT_SECRET=
```

参考[官方 SDK 接入说明](https://github.com/WecomTeam/aibot-node-sdk)。不是传统群 Webhook Bot，也不是人类账号。
Bot 必须对测试成员可见；不要把 Secret、成员 ID、原始聊天日志贴到 Issue。

```bash
pnpm enroll:direct
```

保持这个 Bot 的其他 Gateway / 插件实例停止。在你与 Bot 的私聊中发送终端显示的一次性口令。
成功后自动追加该成员到授权名单，保留原有成员；两分钟未收到会超时，可重试。
本机 owner lock 会拒绝已占用的 Bot，避免注册工具挤掉正在运行的服务。

## 4. 开始真实对话

```bash
pnpm start:checked
```

Doctor 通过后服务保持前台运行。发送：

> 记住项目代号是青竹，简单确认即可。

再发送：

> 刚才的项目代号是什么？

预期先有接收状态，随后同一条消息逐步更新为回答，第二轮记得“青竹”。Agent 若不提供文本增量，不会凭空产生逐字流式。
新手配置关闭普通回复动作和长任务控制卡，**普通聊天不应该每次附卡**。

Gateway 管理独立 Agent session，不会接管你电脑上已打开的终端或桌面任务；切换 Kernel 不迁移其历史。
宿主机与 Gateway 都需要保持在线。冷启动、排队和模型思考都会影响首段正文耗时，不能把模型延迟等同于链路延迟。

## 5. 获得第二个有用的效果

在 Gateway 仍运行时，另开终端，在本仓库目录执行：

```bash
pnpm proactive:send --target direct --text '本地任务完成，可以查看结果了。'
```

生成器已开启私有本地控制 socket，CLI 不需要 Bot Secret。`direct` 别名要求恰好一个授权成员；
多人部署请按[真实联调手册](real-wecom-runbook.md)设置明确的目标别名。送达状态不等于用户已阅读。

接下来按需增加，不必一开始全部配置：

| 目标                         | 入口                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| 项目问答、截图排障、完成通知 | [使用场景](use-cases.md)                                                                          |
| 群聊 @Bot                    | [真实联调手册](real-wecom-runbook.md)：配置群范围与 sender ACL；群内上下文可能共享                |
| 图片 / 文件 / 视频 / 卡片    | [真实案例](verified-kernel-cases.md)与[交互卡片](interaction-cards.md)：先核对 Adapter 与模型能力 |
| 开机常驻、健康检查           | [部署说明](deployment.md)：单 Bot 单实例，不依赖终端保持打开                                      |
| 自己的 Agent / harness       | [Adapter 开发](adapter-authoring.md)和[模板导航](../examples/README.md)                           |

## 出问题时先看哪层

| 现象                    | 先查                                                      |
| ----------------------- | --------------------------------------------------------- |
| `pnpm demo` 失败        | Node/pnpm 版本、依赖安装；与账号无关                      |
| `pnpm agent:check` 失败 | Agent 本机登录、provider/model、Adapter 配置；未接触 Bot  |
| 注册超时                | Bot 可见范围、是否发给了正确 Bot、是否发送原样口令        |
| Bot 已被占用            | 停止旧实例，不要同时运行官方插件和本 Gateway 连接同一 Bot |
| 完全不回复              | `pnpm doctor`、服务是否在线、私聊 / 群聊授权范围          |
| 有状态但正文很慢        | 查看队列 / Agent 首事件 / 首文本 / 最终完成分层指标       |
| 图片收到了但看不懂      | 当前 Agent 和模型是否提供视觉能力；传输不等于理解         |
| 更改配置未生效          | 安全停止并重启服务；不要在旧实例旁再开一个                |

提交问题请用[上手反馈](https://github.com/fyaic/wecom-agent-gateway/issues/new?template=onboarding.yml)，
提供命令阶段、版本和脱敏错误，不提供凭据或原始聊天记录。
