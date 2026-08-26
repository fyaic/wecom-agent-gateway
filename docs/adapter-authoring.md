# Kernel Adapter 接入指南

本项目的扩展点是 `AgentRuntimeAdapter`，不是企业微信 SDK、Prompt 模板或自然语言路由。新的 Kernel
只翻译自身 SDK/RPC 与 Runtime Contract v1；企业微信认证、ACL、媒体解密、队列、Outbox 和可变 Bot
消息由 Gateway 统一承担。

## 最小实现

Adapter 必须提供：

- 唯一、稳定、无用户数据的 `id`；
- `contractVersion: 1`；
- 精确的 `capabilities`；
- 声明实际支持的 `inputModalities` / `outputModalities`，不能只用粗粒度 multimodal capability；
- `run()`、`health()`，以及需要时的无语义 `start()`/`stop()`、`cancel()`；
- opaque session 的首次创建和恢复；上游 session 格式变化时更新 `sessionCompatibilityId`。

接入必须运行 `exerciseTextRuntimeContract()`；声明 `reply-actions` 时还必须运行
`exerciseReplyActionRuntimeContract()`，并以 deterministic fake 覆盖 wire protocol、错误、取消、
多模态和事件间隙。真实 smoke 必须分开记录 Channel 回执、Kernel 首事件、首文本和最终完成，不能用
总耗时猜测缺陷所在层。

## 外部 Adapter SDK

不使用现有 ACP 或内置 Adapter 时，从
[`examples/adapter-template`](../examples/adapter-template) 复制最小包。模块默认导出 factory：

```ts
import { defineRuntimeAdapter } from "@fyaic/wecom-adapter-sdk";

export default defineRuntimeAdapter(
  async ({ contractVersion, config, tools }) => {
    return {
      id: "my-kernel",
      contractVersion,
      sessionCompatibilityId: "my-kernel:wire-v1",
      capabilities: new Set(["streaming", "resume"]),
      async *run(request) {
        // 在这里忠实翻译目标 Kernel SDK/RPC，并 yield Runtime Contract 事件。
      },
      async health() {
        return { ok: true };
      },
    };
  },
);
```

在私有 `.env` 选择它，不修改 `apps/gateway/src/adapter-registry.ts`：

```dotenv
GATEWAY_ADAPTER=external
GATEWAY_EXTERNAL_ADAPTER_MODULE=./path/to/adapter/src/index.ts
GATEWAY_EXTERNAL_ADAPTER_CONFIG_JSON={"model":"adapter-owned-value"}
```

模块也可以是已安装的 package name；相对路径从
`GATEWAY_EXTERNAL_ADAPTER_BASE_DIRECTORY`（默认 Gateway 工作目录）解析。远程 URL、`data:`、`node:` 和
无效 Contract 在 Bot 入口启动前拒绝。factory config 不应包含 Bot 凭据；它属于 Adapter 自己的私有
配置。若启用 Gateway RuntimeTools，Adapter 只有在真实实现该桥且声明 `tools` capability 时才会装载。

external 是显式可信的进程内扩展，不是沙箱；模块仍可能通过 Node 访问宿主环境。不可信或需要强隔离的
Kernel 应使用 ACP 子进程和环境 allowlist。Gateway SDK 不负责 Agent 的模型、Prompt、工具策略或思考。

## Capability 语义

| Capability                | v1 含义                                                           |
| ------------------------- | ----------------------------------------------------------------- |
| `streaming`               | Adapter 实际发出有序文本增量，最终正文与增量拼接一致              |
| `resume`                  | 可用 opaque session 继续同一 Kernel 上下文                        |
| `cancel`                  | 可取消指定 session 的当前 run                                     |
| `approval`                | 可把 Kernel 的权限请求映射到 Gateway 审批控制面                   |
| `tools`                   | 可注入并调用 Gateway 提供的 `RuntimeTool` catalog                 |
| `status-events`           | 可忠实转发 Kernel 显式的面向用户状态；不是 Channel 推断“正在思考” |
| `multimodal-input`        | 至少一种非文本输入可原生传入；具体类型仍由 Adapter 协商或明确拒绝 |
| `multimodal-output`       | 可产生受根目录、大小和数量约束的 `media-output`                   |
| `interaction-resume`      | 可接收持久化的结构化交互结果并恢复同一 Kernel session             |
| `interaction-live-resume` | 结果是仍在等待的原生调用控制响应；允许绕过语义 turn 队列          |
| `reply-actions`           | 可附最终快捷动作，并把真实 callback 作为新 turn 继续同一 session  |

Kernel 自己拥有工具不等于 `tools`；模型支持图片也不等于 Adapter 已实现安全媒体输入。
声明 `cancel` 后，Gateway 可以在长任务超过阈值时提供一次通用停止卡；Adapter 的 `cancel(sessionId)` 必须
只中断该 session 当前 run、可安全重复调用，并且不能把“停止任务”转换成新 Prompt。

## 当前兼容矩阵

验证快照：2026-08-26。

| Adapter               | 上游接口            | 固定/实测版本                                  | 已验证能力                                                                                 |
| --------------------- | ------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Codex SDK 对照实现    | `@openai/codex-sdk` | SDK `0.148.0`                                  | 文本流式、session 恢复、reply-action continuation                                          |
| Codex App Server      | JSONL App Server    | CLI `0.145.0`                                  | 流式、恢复、回复动作、原生 ask-user、取消、状态、审批、RuntimeTool、图片/音频输入          |
| 通用 ACP              | ACP v1 stdio        | `@agentclientprotocol/sdk 1.4.0`               | 流式/取消/权限；session load 可用时动态开放恢复、回复动作和输入模态                        |
| Kimi Code（通用 ACP） | `kimi acp`          | Kimi `0.36.1`                                  | 流式、恢复、回复动作、取消、权限、状态、图片输入；真实企业微信私聊已通过                   |
| OpenClaw Gateway      | WebSocket v4        | Client `2026.8.1-beta.2`；Gateway `2026.7.1-2` | 流式、恢复、回复动作、取消、状态；image/audio/video/file 输入                              |
| Pi Agent              | 官方 JSONL RPC      | Pi `0.84.2`；GLM-5.2 文本、GLM-4.6V 图片通过   | 流式/恢复/回复动作/取消/状态；动态图片输入；原生选择/确认/文本交互；默认 2-worker 有界并发 |

OpenClaw 当前客户端与 Gateway 跨 release train，已通过 `agent.wait + chat.history` 终态对账覆盖事件间隙；
升级任一侧时必须重跑 fake contract、本机两轮 smoke、企业微信私聊和群聊矩阵。

Pi 官方当前没有 ACP 接口；它提供 `pi --mode rpc` 的严格 LF JSONL 协议和同包 Node SDK。其 RPC 支持
异步 `prompt`、base64 图片、`message_update/text_delta`、完全终态 `agent_settled`、`abort`、
`get_state` 与 `switch_session`。因此 Pi 使用独立窄 Adapter，不能假装成 ACP wire type。当前实现以
有上限的长期进程池承载企业微信 session，默认 `PI_MAX_WORKERS=2`；同 session keyed lock 串行，
不同 session 可在不同 worker 并行。`agent_settled` 是唯一成功终态。Pi 原生
`extension_ui_request` 中的 select/confirm/input/editor 会产生 `interaction-requested`；Gateway
完成卡片或限定文本交互后，Adapter 以同 request ID 的 `extension_ui_response` 恢复原调用。自带 timeout、
重复 pending 或无法映射的 dialog fail closed。图片以受保护本地文件读取后转 base64，文件/音频/视频
明确失败。
`multimodal-input` 不是静态承诺：Adapter 从 `get_state.model.input` 动态协商。当前真实
`zai/glm-5.2` 只接受文本，因此不声明图片；自定义 `zai-vision/glm-4.6v` 声明图片输入并已完成本机
真实截图识别。两种模型共用同一个 Adapter，没有按模型硬编码 capability。

Pi RPC 的 `prompt.message` 和当前 GLM-4.6V 兼容端点要求图片旁存在非空字符串。纯图片输入只映射为
单个空格的协议填充，不加入“描述图片”等语义指令；图片仍以原始 base64 内容交给 Kernel。这是 wire
compatibility，不是 Channel 替 Agent 思考或把媒体改写成文字。

## 明确禁止

- 把媒体改写成文字占位、把工具描述塞进 Prompt，或用虚假 hello 预热 session；
- 继承 Bot secret、数据库路径或全部宿主环境给 Kernel 子进程；
- 在 Adapter 中决定业务路由、模型选择或用户意图；
- 把 session、tool call、用户或会话内部 ID 输出到普通日志或用户消息。

## ask-user / elicitation 接入规则

Adapter 只在 Kernel 真实请求用户输入时发出 `{type: "interaction-requested"}`，不得从自然语言猜测。
请求必须使用稳定的 Runtime 语义，不含企业微信卡片 JSON、callback key 或目标 ID。
等价选择不要携带视觉偏置；通用 action 只有在 Kernel 已明确 primary/danger 语义时才设置 `style`，
不得把数组第一项自动视为推荐操作。

普通实现声明 `interaction-resume`，结束当前 run 后由 Gateway durable queue 恢复同一 session。只有当
Kernel 的原调用仍在等待控制响应时才额外声明 `interaction-live-resume`；这条响应不会经过正常会话队列，
Adapter 必须验证 session 仍绑定原 live worker，并按 idempotency key 忽略重复投递。任何失败都不能通过
合成用户 Prompt 来“模拟恢复”。
若一个上游请求包含多个 Channel 无法原子表达的字段，Adapter 可以在一次 live resume 中返回下一条
`interaction-requested`；必须保留同一上游 request、已收集答案和明确终止条件。new-turn callback 不得
使用这种嵌套路径。秘密输入、密码和 token 不得降级为 IM 文本交互。

最终回复快捷操作与 live ask-user 不同。Adapter 只有在能把
`resumeMode=new-turn` 的 callback continuation 恢复为同 session 新回合时才声明 `reply-actions`；所选
value 是 Adapter 预先绑定的规范化输入，不得是 shell 命令或厂商卡片 JSON。该 continuation 必须经过
Gateway 正常会话队列和并发限制，不能借 `interaction-live-resume` 绕过背压。
操作员配置的默认 reply actions 只用于普通入站首轮，不会自动继承到 callback continuation。Adapter
只有在有明确下一步和终止条件时才应在 continuation 的 `message-completed` 中再次显式返回 `actions`。

SDK loader 会校验 capability 与方法的一致性：`reply-actions` 和 `interaction-live-resume` 必须同时声明
`interaction-resume`，声明后必须实现 `resumeInteraction()`。仓库模板已经给出同 session new-turn 与
进程内有界幂等的最小实现；Adapter 不应从按钮 label 猜 Prompt。

ACP v1 的 `session/request_permission` 是工具授权，不是普通 ask-user；当前 OpenClaw Gateway v4 的公共
schema 也没有导出可由外部客户端响应的 elicitation 请求。两者继续使用审批、取消和 new-turn 回复动作，
但不得声明 `interaction-live-resume`。若未来上游增加正式 capability/method，必须先固定版本、验证请求
与响应关联，再新增桥接。
