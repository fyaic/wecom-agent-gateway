# 中间层社区观察与执行顺序

快照：2026-09-05。定位：**容易接入、忠实传输、故障可诊断的独立 Agent IM 中间层**。
不负责模型、提示词、人格、Agent 思考或办公流程；卡片仅承载 Agent 显式交互。

本次检查公开 README、集成文档、GitHub Issue/PR 和官方 SDK npm 版本；没有安装或实测其他项目。
下文“声明”不等于认证，Issue 是用户报告而非已确认根因，未合并 PR 不计入已发布功能。
不复制竞品代码；没有核实的许可证不作推断。知名度应来自可复现的接入体验和问题解决记录，而非功能计数。

## 同类项目值得学什么

| 项目 / 本次观察入口                                                                                                                                               | 可借鉴的优点                                                                                               | 与本项目的差异、不能据此承诺的能力                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [The-NeXT-AI/bot-gateway](https://github.com/The-NeXT-AI/bot-gateway)、[集成协议](https://github.com/The-NeXT-AI/bot-gateway/blob/main/docs/agent-integration.md) | 入站事件、出站 intent、消费 ACK 分离；HTTP/WS/stdio 面向外部 Agent；多语言 SDK 降低接入耦合                | 文档明确 WeCom 是 generic webhook/dry-run shell，不能视作真实企微对标认证。本项目目前是可信本地模块 SDK，不宣称已有远程多语言协议                             |
| [KKRainbow/agent-router](https://github.com/KKRainbow/agent-router)                                                                                               | 清晰说明“路由器不是 Agent”；公开协议适配 Kimi ACP、Codex app-server、Claude stream-json；状态/停止入口明确 | Slack/QQ/浏览器入口，不是相同企微实现；切换时上下文投影、LLM 路由不进入我们的 Core                                                                            |
| [tmwgsicp/im-cli-bridge](https://github.com/tmwgsicp/im-cli-bridge)                                                                                               | 简单平台/CLI 配置、启动/停止/日志和状态命令，便于日常维护                                                  | README 的多平台稳定声明未经本次实测，流式预览仍列在后续计划；WeCom 配置是应用凭据路径，不等同官方 aibot 长连接；人格/调度/自动写入各 CLI 规则不属于我们的范围 |
| [imtoagent/imtoagent](https://github.com/imtoagent/imtoagent)                                                                                                     | 引导配置、状态入口、数据目录与源码分离                                                                     | 同时包含模型代理、provider/persona 管理；这些不复制到中间层。WeCom 使用 HTTP Webhook 路径                                                                     |

这些项目的普通 Issue 样本很少，不能把“零 Issue”解释为稳定或成熟；也不比较未经同环境测量的速度。

## 社区痛点 → 我们的应对与边界

| 可核对的公开信号                                                                                                                | 用户真正遇到的问题                              | 已有措施 / 本轮动作 / 尚未解决                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 官方插件 [#184](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/184)                                                  | 后台触发任务，IM 没有结果；报告涉及选择交互     | 中立审批/交互状态和失败路径已存在。本轮加入运行状态汇总；它能显示等待/积压，但不能据此认定该上游问题根因，也不代表所有 OpenClaw 交互已映射           |
| 官方插件 [#183](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/183)                                                  | 升级后工具运行时未初始化                        | 独立 Gateway 与公开 Agent 协议避免依赖该插件私有 runtime store；仍需针对 Host 升级做兼容回归，不宣称免维护                                           |
| 官方插件 [#178](https://github.com/WecomTeam/wecom-openclaw-plugin/issues/178)                                                  | 相对路径附件不能发出，却降级文本并返回成功      | 保留媒体根目录、受控 spool、durable outbox 的边界；本轮状态明确区分 ready 与 dead 投递。SDK 接受也不代表用户已看到附件                               |
| SDK [#27](https://github.com/WecomTeam/aibot-node-sdk/issues/27)、[PR #28](https://github.com/WecomTeam/aibot-node-sdk/pull/28) | ACK 慢可能触发重复媒体分块；建议可配置 ACK 超时 | 现有测试覆盖晚 ACK 丢弃过时 partial、保留 final、队列饱和上抛。本次 PR 仍未合并，不声称 SDK 已解决分块重复，更不承诺 exactly-once                    |
| sunnoy [#187](https://github.com/sunnoy/openclaw-plugin-wecom/issues/187)                                                       | 流式内容夹杂 thinking、可见文本重复             | Adapter 区分可见输出与内部事件，Core 不从文本猜测思考状态；不能通过展示隐藏推理来制造“回复更快”                                                      |
| sunnoy [#183](https://github.com/sunnoy/openclaw-plugin-wecom/issues/183)                                                       | 更换插件后感觉明显变慢                          | 报告只有标题、无 benchmark。我们分别记录排队/首回执/Agent 首文本/结束时间，不把模型生成耗时当链路 SLA                                                |
| imtoagent [#1](https://github.com/imtoagent/imtoagent/issues/1)                                                                 | 用户报告备份配置意外提交密钥                    | 未访问或验证其疑似密钥。本项目私有配置、发布检查继续保留；本轮消除 Doctor 原始 health detail / exception / Adapter ID 输出，状态报告只取固定聚合字段 |
| SDK [#23](https://github.com/WecomTeam/aibot-node-sdk/issues/23)                                                                | 主动推送会话范围与流式模式受限                  | 平台权限与投递语义不能由中间层绕过；主动消息不等同可任意修改的回复流                                                                                 |

官方 ask-user [PR #176](https://github.com/WecomTeam/wecom-openclaw-plugin/pull/176) 本次仍未合并。
借鉴显式回调与超时处理，但不把其实现记成官方已经发布。当前官方 SDK npm `latest` 实查仍为 `1.0.7`，
与锁文件一致，本轮无需升级依赖；GitHub main 中的 package 版本不能替代 npm 发布版本。

## 本轮落地：无需连接新 Bot 的状态报告

`pnpm gateway:status` 读取现有 loopback `/metrics`，不启动 Agent、不执行工具、不修改数据库。
详细使用及状态解释见[运行排障](gateway-status.md)。同时修复 Doctor 诊断输出的原始错误泄漏风险。

验证入口：

```bash
pnpm exec vitest run scripts/gateway-status.test.ts apps/gateway/test/doctor.test.ts
pnpm test:m3-upstream-compatibility
pnpm run ci
```

新增测试通过实际本地 HTTP server 检查 ready 但 dead、等待任务/审批、组件异常、固定字段隐私、
缺字段/重复/矛盾/非法指标、非 loopback 拒绝、重定向拒绝、有界响应和超时。
2026-09-05 对现有运行服务只读检查：ready、Transport、Store 均健康，1/1 Adapter 健康；
pending/leased/dead 和 active/pending approval 均为 0。**这是瞬时运维状态，不是本轮新增的聊天送达或视觉验收。**

## 后续优先级与退出条件

1. **P0：可靠性证据，而非新增主题卡片。** 保留并补齐真实原生 video callback、真实入站引用、
   Linux 24h soak、宿主机真实断网/上传失败恢复证据。需要符合条件的客户端/宿主机；fixture 不能替代。
2. **P0：把社区故障转为固定回归。** 当前晚 ACK/final 和媒体权限矩阵见
   [上游兼容矩阵](upstream-compatibility.md)。新上游版本先跑矩阵，再发布明确的支持版本；
   扩展 ACK/上传故障注入时必须区分“重试可恢复”和“无法确认是否已送达”。
3. **P1：安装与运行闭环。** demo → onboard → Agent 检查 → Bot 首聊 → status。
   下一切片验证无已有缓存的新环境安装，再决定版本化安装包；退出条件是干净 macOS/Linux 可按公开步骤复现、
   凭据不进入包、升级可回退，而不是加入一个未经验证的 curl 安装脚本。
4. **P1：外部 Agent 接入面 ADR。** 借鉴 bot-gateway 的显式事件/ACK，但先设计鉴权、会话所有权、
   取消、重放、背压、媒体授权和协议版本；退出条件是一个仅依赖公开协议的独立消费者通过 conformance。
   现有本地 Adapter SDK 继续可用，不为“通用”立即开放未鉴权 HTTP 服务。
5. **P2：社区反馈与传播。** 用已有真实 GIF、两种独立 Agent 的复现配方和脱敏故障 Issue 展示价值；
   每次发布列清已测版本/未覆盖项。先在自己仓库积累可复现案例，不冒充上游修复、不去其他项目 Issue 广告引流。

本轮不增加模型/provider 管理、自动 Agent 选择、跨 Agent 记忆迁移，也不把界面控件数量作为里程碑。
