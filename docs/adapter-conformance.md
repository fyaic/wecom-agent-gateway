# Adapter Conformance Kit

Adapter Conformance Kit 用来证明一个 Kernel Adapter 遵守 Runtime Contract v1，而不是证明模型回答质量或
企业微信 Transport 可用。它可以不启动 Gateway、不连接企业微信，直接通过公共 Adapter SDK 装载仓库外模块。

## 快速运行

```bash
pnpm --silent conformance:adapter \
  --module ./examples/clean-room-adapter/src/index.ts \
  --base-directory . \
  --config '{"prefix":"certified: "}' \
  --image docs/assets/verified-kernel-cases/pi-wecom-private.png \
  --exercise-cancel \
  --pretty
```

`--silent` 会隐藏 package manager 的脚本前缀，使 stdout 只有 JSON；任一已执行检查失败时退出码为 1。报告
不包含 Adapter 抛出的错误正文、消息内容、
session、用户/会话 ID、媒体路径或凭据。失败只使用稳定错误码，适合进入 CI artifact 或公开证据。

## 检查语义

| 检查                        | 条件                       | 证明范围                                                          |
| --------------------------- | -------------------------- | ----------------------------------------------------------------- |
| `adapter.compatibility`     | 必跑                       | v1、稳定 ID、capability/method 和模态声明基本一致                 |
| `adapter.health`            | 必跑                       | Adapter 在有界时间内报告 ready                                    |
| `turn.text`                 | 必跑                       | 唯一成功终态；声明 streaming 时 delta 拼接等于 final              |
| `turn.session-resume`       | 声明 `resume`              | 使用首次 opaque session 恢复且不创建不同 session                  |
| `turn.quoted-context`       | 声明 `quoted-context`      | 可接收结构化 quote 并产生合法终态；语义保真还需 Adapter fake 断言 |
| `turn.media.<type>`         | 声明模态且提供本地 fixture | 该模态可进入 Adapter 并产生合法终态；模型理解质量不在范围内       |
| `interaction.reply-actions` | 声明 `reply-actions`       | 同 session new-turn 与重复 idempotency key 零事件                 |
| `turn.cancel`               | 声明 `cancel` 且显式启用   | live run 在重复 cancel 后以唯一失败终态结束，不误报成功           |

`approval`、`tools`、`status-events`、`multimodal-output` 和 `interaction-live-resume` 需要目标 Kernel 的
deterministic fake 主动产生对应事件。通用 runner 会把它们标成
`requires-adapter-specific-deterministic-probe`，不能仅凭 capability 声明判定通过。

## 认证分层

1. **静态/通用 conformance**：本工具输出的 JSON；检查协议形状和可通用执行的行为。
2. **Adapter fake contract**：在对应 Adapter package 中验证 wire、错误、权限、事件间隙和特有能力。
3. **真实 Kernel smoke**：验证固定版本、认证、两轮 session、取消和模态，不连接企业微信也可执行。
4. **真实 WeCom E2E**：最后验证 Transport → Core → Adapter → Kernel；分开记录回执、首文本、完成和投递。

四层不能互相冒充。clean-room 示例的固定报告见
[`evidence/adapter-conformance-clean-room.json`](evidence/adapter-conformance-clean-room.json)，CI 会重新生成并
比较，防止实现和公开证据漂移。
