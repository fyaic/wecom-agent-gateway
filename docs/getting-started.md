# 15 分钟接入指南

目标：让一个已经能独立运行的 Agent，通过一个企业微信智能机器人完成授权私聊中的收消息、流式回复和
会话恢复。本文只走最短主链路；群聊、媒体、卡片、主动消息和故障验收放在后续步骤。

## 你最终会得到什么

```text
企业微信私聊 → Bot → WeCom Agent Gateway → 选定的 Agent
企业微信私聊 ← 同一条可变流式回复 ←──────────────┘
```

Gateway 不提供模型或托管 Agent。开始前先确认目标 Agent 在命令行或本地服务中可以正常回答。

## 1. 安装并验证仓库

需要 Node.js 22 和 pnpm 11.8.0：

```bash
git clone https://github.com/fyaic/wecom-agent-gateway.git
cd wecom-agent-gateway
pnpm install --frozen-lockfile
pnpm run ci
```

这一步不连接企业微信、不使用模型额度。全部通过后再引入真实凭据，能显著缩小排障范围。

## 2. 准备企业微信 Bot

在企业微信智能机器人管理页创建或选择一个专用 Bot，开启长连接/API 模式，取得 Bot ID 和 Secret。
一个 Bot 同一时间只允许运行一个 Gateway 实例。官方连接能力与配置方式见
[`@wecom/aibot-node-sdk`](https://github.com/WecomTeam/aibot-node-sdk)。

```bash
cp .env.example .env
chmod 600 .env
```

填写：

```dotenv
WECOM_BOT_ID=
WECOM_BOT_SECRET=
```

不要把 `.env`、Bot Secret、内部成员/会话 ID 或原始聊天日志提交到 GitHub。

## 3. 选择一个 Agent Adapter

每个 Gateway 进程只选一个：

| Agent     | 最小选择                   | 前置条件                                      |
| --------- | -------------------------- | --------------------------------------------- |
| OpenClaw  | `GATEWAY_ADAPTER=openclaw` | 本地 OpenClaw Gateway 已运行                  |
| Pi Agent  | `GATEWAY_ADAPTER=pi`       | `pi --mode rpc` 可运行，provider/model 已配置 |
| Kimi Code | `GATEWAY_ADAPTER=kimi`     | `kimi acp` 可运行且已登录                     |
| Codex     | `GATEWAY_ADAPTER=codex`    | `codex app-server` 可运行且已完成所需登录     |
| 通用 ACP  | `GATEWAY_ADAPTER=acp`      | 已知 ACP v1 executable 与参数                 |

例如 OpenClaw：

```dotenv
GATEWAY_ADAPTER=openclaw
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
```

先用 Agent 自身的命令确认它能工作；注册 ACL 后可再运行 `pnpm doctor:live` 做完整上游探测。如果
Agent 自身不可用，先在 Agent 一侧修复，不要用 Gateway 掩盖模型、provider 或登录问题。

## 4. 注册第一个授权私聊

```bash
pnpm enroll:direct --name '授权测试成员'
```

命令会连接 Bot 并显示一次性口令。在该成员与 Bot 的私聊中原样发送口令；成功后 Gateway 只保存所需
sender 范围，不在终端打印内部 ID。

## 5. 启动并发送第一条消息

```bash
pnpm doctor
# 可选：真实探测所选 Agent 上游
pnpm doctor:live
pnpm start:checked
```

在已注册的私聊里发送一句普通文本。预期顺序是：

1. 很快看到中性接收回执；
2. 同一条 Bot 消息开始出现 Agent 文本增量；
3. 最终正文原位完成；
4. 第二条消息复用同一个 Agent session。

普通回复默认不附加卡片。只有 Agent 明确请求用户交互，或部署显式配置回复动作/长任务控制时，才会
出现独立卡片。

## 6. 下一步

| 目标                 | 文档或命令                                                                  |
| -------------------- | --------------------------------------------------------------------------- |
| 增加授权群聊         | 安装并授权 `wecom-cli`，按[真实联调手册](real-wecom-runbook.md)解析唯一群名 |
| 主动发送消息         | 设置 `GATEWAY_CONTROL_ENABLED=true`，运行 `pnpm proactive:health`           |
| 接入图片、文件、视频 | 配置媒体根目录并按[真实联调手册](real-wecom-runbook.md)逐项验证             |
| 增加新的 Agent       | 阅读 [Adapter 开发指南](adapter-authoring.md)                               |
| 生产部署             | 阅读 [Linux/systemd 与容器基线](deployment.md)                              |
| 查看真实结果         | 阅读 [Codex、Kimi、OpenClaw、Pi 案例](verified-kernel-cases.md)             |

## 常见问题

- **完全不回复**：先运行 `pnpm doctor`，确认 Bot 没有被第二个 Gateway 占用，再检查 direct/group ACL。
- **回复很慢**：区分 Channel 回执、排队、Agent 首事件、首文本和最终完成；模型耗时不等于企业微信链路耗时。
- **每条消息都出现卡片**：检查 `GATEWAY_REPLY_ACTIONS_JSON` 和长任务控制配置；默认值不会给普通回复附卡。
- **媒体到达但 Agent 不理解**：Transport 成功不代表当前模型或 Agent 工具支持该模态；能力协商会明确区分。
- **需要办公 API**：把官方 `wecom-cli` 当作 Agent 工具层使用，不要把它与 Bot IM 身份混为一层。

更完整的真实验收、故障恢复和各 Adapter 版本证据见[真实企业微信联调手册](real-wecom-runbook.md)与
[项目状态](status.md)。
