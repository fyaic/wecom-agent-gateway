# ADR 0026：单 Bot 进程所有权与多实例边界

- 状态：Accepted
- 日期：2026-09-02

## 背景

官方企业微信 SDK 为一个 Bot 建立 WebSocket 连接。Outbox lease 只解决“哪个 worker 投递一条记录”，
不能阻止两个 Gateway 进程同时连接同一个 Bot、重复消费 callback，并各自在内存中维护不同的会话顺序、
admission 和交互状态。当前 SQLite、媒体目录和本地控制面也没有形成跨主机一致性协议，因此项目不能把
两个进程都启动成功解释成高可用。

## 决策

Gateway 在创建 Store、Kernel Adapter 或官方 SDK Transport 之前获取一个本机进程 owner lock：

- key 是 Bot ID 的 SHA-256 指纹；私有锁记录不保存 Bot ID 或 Secret，常规日志与错误正文也不输出该指纹；
- 同一操作系统用户和锁目录中，同一 Bot 只允许一个活跃 owner；第二进程立即以明确诊断退出，不连接 SDK；
- 正常退出立即释放；同主机进程消失后按 PID 立即回收，无法验证 PID 的跨主机/命名空间记录则依靠有界
  heartbeat timeout 回收；
- 锁目录和记录分别使用 `0700` / `0600`。本地默认位于每用户临时目录；systemd 和 Compose 明确放入
  持久状态目录，避免 private tmp 或容器命名空间绕过同一部署单元的冲突检测；
- owner lock 只保护 Bot 连接所有权，不代替 Outbox delivery lease，也不提供 conversation fencing。

该机制证明的是 **single-active fail-fast**，不是 active-active。不同主机、不同容器状态卷或人为配置不同
`GATEWAY_OWNER_LOCK_ROOT` 时无法形成全局互斥；部署者不得把这些实例同时指向同一 Bot。

## 多实例语义约束

实现真正多实例前，必须先有独立 ADR 和可执行故障模型，至少定义：

1. Bot account connection owner 的租约存储、续租、fencing token 与失联回收；
2. conversation owner、全局顺序、共享 admission/backpressure 和 callback 幂等；
3. durable outbox、interaction resume、媒体 artifact 的共享存储与提交边界；
4. 正常切换、进程崩溃、网络分区和恢复时唯一允许的行为，以及 failover RTO；
5. 旧 owner 恢复后如何被 fencing，不能仅靠 PID、时间或“最后写入者获胜”。

在上述条件完成前，仓库和文档只承诺一个 Bot 一个活跃 Gateway。

## 后果

- 启动错误更早、更安全；第二进程不会生成 Kernel 子进程、触碰 SQLite 或连接企业微信。
- 同一主机测试和常规误部署可以确定性失败；跨主机 HA 仍明确不受支持。
- 强杀后的锁回收不影响 SQLite Outbox 自己的 30 秒 delivery lease；两层所有权保持独立。
