# 出站媒体与失败恢复审查

日期：2026-09-05。范围：Bot Transport 的错误分类与 Core 的 Outbox 恢复；不新增产品能力，
不改变 Kernel、SDK 版本、存储实现、生产配置或 Bot 连接。

## 发现并修复

`hasErrorCode` 原先通过错误文本包含 `846608` 判定流式窗口过期。这会把带有该数字的请求 ID、
超时文本，甚至明确返回其他错误码的回执，误判为“已知窗口过期”，随后主动发送最终文本。
一个送达情况未知的流式请求因此可能额外产生主动消息，并被标记为已接受。

修复只接受官方 SDK 负回执中的结构化数值 `errcode`。文本相似、文本错误码或字段冲突都继续
向 Outbox 报错，不擅自改为主动推送。没有自行实现 ACK、上传分片或重连协议。

回归验证：临时恢复原判断后，三个新增分类测试均失败（错误地返回成功回执）；恢复修复后三项通过。
原有结构化 `846608` 的最终文本主动发送测试继续通过。

## 可复现证据

执行：

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run packages/transport-wecom-bot/test/transport.test.ts packages/channel-core/test/gateway.test.ts
pnpm run ci
```

定向测试共 99 项通过；本轮增加 11 项。全量 `pnpm run ci` 通过：37 个测试文件、297 项测试，
格式、类型检查与公开文件检查均通过。测试均使用 fake Client/Transport、内存 Store/Spool；
媒体 Transport 测试读取临时目录中的真实文件，但没有向企业微信上传这些文件。

| 场景                        | 断言与含义                                                                 |
| --------------------------- | -------------------------------------------------------------------------- |
| 上传明确拒绝                | 不调用媒体发送；不返回成功回执；不降级为“文本 + 本地路径”假成功            |
| 媒体发送 ACK 未知           | 保留原错误，无成功回执；发送可能已被远端接受，与上传拒绝不同               |
| 媒体 ACK 延后               | ACK 未 settle 前，delivery Promise 不产生成功回执                          |
| 恢复重试                    | 首次失败时 Outbox pending、媒体未释放；重试收到回执后记录 delivered 并释放 |
| 重试耗尽                    | 两次失败后 dead-letter、没有 delivered 事件；释放已终结条目的媒体资源      |
| 远端 ACK 后本地完成写入失败 | 保留 lease 和媒体；租约到期后恢复；可能重复投递，不承诺 exactly-once       |
| final 故障恢复（已有）      | Agent 不因失败停止；仅重试最新 stream 状态，旧 partial 被 supersede        |
| partial 晚 ACK（已有）      | SDK 边界可跳过积压 partial，但 final 仍提交                                |
| 回复队列饱和（已有）        | 错误上抛供持久 Outbox 重试，不伪造接受                                     |

对应测试：[Transport](../../packages/transport-wecom-bot/test/transport.test.ts)、
[Core](../../packages/channel-core/test/gateway.test.ts)。没有因为已有路径正确而重写 Core。

## 必须保留的语义边界

- `delivered` 是 Transport 获得上游接受回执，不是客户端可见、已读或 Agent 理解。
- `sendProactiveMedia` 在远端 ACK 成功而本地完成写入失败时仍返回 `delivered`；此时持久台账保持
  leased，基础设施事件报告完成写入错误。本轮测试明确两者含义，不把 API 返回值当成持久提交证明。
- **dead-letter 表示自动重试耗尽，不等于远端肯定没收到。** 测试故意让未知 ACK 的远端存在副本，
  仍不产生虚假的 delivered 证据。恢复重试也可能重复；当前是 at-least-once，不是去重送达保证。
- 未改变 SDK 1.0.7 的上传分片重试/ACK 超时。阅读了已安装 SDK 的 `handleReplyAck`（负回执拒绝
  structured frame）、`uploadMedia` 和 `replyStreamNonBlocking` 实现；这是代码核对，不是官方服务器实测。
- 本轮没有新建真实 SDK WebSocket、操作真实客户端、断开宿主网络或执行 24 小时 soak。
  原生 `msgtype=video` 和引用真实 callback、真实断网/上传失败恢复、Linux 24 小时仍未认证。

结论：本切片关闭一个可复现的错误分类缺陷，增强现有恢复语义的自动化证据；不宣布主线全部完成。
