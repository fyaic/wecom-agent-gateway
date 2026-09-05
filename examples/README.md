# Examples / 示例导航

先看到效果，再进入协议开发。所有示例均需先在仓库根目录安装依赖；源码示例不是已发布的 npm 包。

| 你要做什么 / Goal         | 入口 / Entry                                                                                      | 证据范围 / Scope                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 无账号看到 Gateway 工作   | 根目录运行 `pnpm demo`                                                                            | 真实 Core + SQLite + 外部加载器，本地 Loopback/Echo；非真实企微、非 AI |
| 没配置模型，先连 Bot      | `pnpm onboard --adapter echo`，随后按[接入指南](../docs/getting-started.md)注册启动               | 真实 Bot 的确定性回显，不代表 Agent 理解能力                           |
| 接入已有 Agent            | [中文](../docs/getting-started.md) / [English](../docs/getting-started.en.md)，`pnpm agent:check` | 检查真实模型两轮与会话连续性；不连接 Bot                               |
| 给自家 harness 写 Adapter | [adapter-template](adapter-template/README.md)                                                    | 可加载 Echo 模板；实现实际 kernel 协议仍需开发                         |
| 验证只依赖公共 SDK        | [clean-room-adapter](clean-room-adapter/README.md)                                                | SDK-only 一致性证据，不冒充额外真实 Agent                              |
| 把 Pi 原生询问接成卡片    | [pi-wecom-interaction.mjs](pi-wecom-interaction.mjs) + [说明](../docs/interaction-cards.md)       | 显式示例扩展，需要加载配置和支持的 Pi Adapter                          |
| 查看已经实际接入的效果    | [真实案例](../docs/verified-kernel-cases.md) / [English](../docs/verified-kernel-cases.en.md)     | 按 Agent、模态与验证范围分别记录                                       |

Daily recipes: [中文](../docs/use-cases.md) / [English](../docs/use-cases.en.md).
Do not put Bot credentials or private conversation logs in these examples.
