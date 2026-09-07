# 已知离线时保留投递预算（2026-09-07）

## 真实失败来源与最小修复

主审的隔离 Linux guest NIC 断网报告记录：服务仍 live、ready=false，主动文本与文件均返回 queued，
Outbox pending=2、spool=1；恢复后却是 dead=2、delivered 未增加、spool=0。现场复核两条各尝试
5 次，约 15 秒就耗尽预算，而实际 guest 断网约 101 秒。**这是一条真实失败记录，不是通过证据。**

根因：立即发送和周期 flush 都直接 claim；claim 会增加持久 attempts，已知断连仍反复调用 deliver，
继而 dead-letter 并清理媒体。解决位置仅在中立 Core：两条 claim 入口都先检查 Transport health。

- 明确 unhealthy、health 抛错或超过 1 秒未返回：保持 pending，不 claim、不消耗 attempts、不释放媒体。
- 缺少 health 方法的旧 Transport 保持原投递行为。官方 Bot health 为只读内存连接状态，不额外联网。
- 健康 Transport 的真实 deliver 失败仍按原有限预算退避/死信；不通过错误文本推断离线，不做无限重试。
- 仅 gate delivery，不阻塞独立的 interaction resume flush。Store、协议、数据库 schema、SDK 均未改变。

## 自动化证据

新增测试使用真实 SQLite、真实本地媒体 spool、fake Transport 和虚拟时钟，无真实 Bot 连接：

1. 离线期间排入文本/文件，删除原文件；虚拟 30 秒后停止/重开 Store+Gateway，再离线 60 秒，
   两条仍 pending、attempts=0，spool 保留；连接恢复后各 delivered/attempts=1，媒体随后清理。
2. 健康 Transport 的永久 API 拒绝仍在 3 次预算后进入 dead-letter。
3. 已有 1 次真实失败后离线 90 秒，不增加也不重置 attempts；恢复成功后 attempts=2。
4. health 不存在时仍能投递；health 抛错/挂起时有界排队，恢复健康后首次成功投递。

复现：`pnpm exec vitest run apps/gateway/test/offline-delivery.test.ts`；全量门为 `pnpm run ci`。

## 仍然成立的边界

连接可能在 health 与实际发送之间变化。这类已经 claim 的在途尝试仍使用原预算与 at-least-once
语义，不凭后续离线信号抹掉一次真实尝试；未知 ACK 也不等于未送达。新门从下一次已知离线的
claim 起保留预算。持续离线的条目保留至恢复，磁盘容量仍需运维监控，不因此宣称无限容量。

本提交的自动化不能代替修复后真实 NIC 复验；原 guest 失败报告及已死信记录应保留，不改写为成功。
guest NIC 与 macOS 宿主物理断网、24 小时 soak 也不是同一证据级别。
