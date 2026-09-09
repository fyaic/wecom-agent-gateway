# Linux 真实 Bot 与断网恢复验收

2026-09-07；首轮代码 `3389f86`（PR #63），Debian 12 ARM64 专属 Lima/VZ VM。
这是实际官方 Bot WebSocket + Pi RPC + SQLite，不是 Echo/Loopback。

## 单实例切换与重启：通过

- 先确认原 macOS 服务没有活动任务或投递积压，再停止该服务；Linux 连接同一 Bot 时没有双实例运行。
- 私聊发送唯一测试标记，要求记住代号；客户端看到正确回复。
- 停止 Linux systemd 服务后重新启动，第二条消息询问该代号，客户端回复正确。
- 两轮真实 ingress 验收均匹配一条消息，九项检查通过，明确绑定 `pi:rpc-v1`。
- 私有配置只包含已有 Bot、授权测试会话和必要 Pi 配置；没有复制宿主聊天历史或挂载宿主目录。

## 客体网卡断开：首轮失败，不能当成恢复通过

实际开始于 04:08:51 UTC。只关闭专属 VM 的 `eth0`，提前启动独立 systemd 恢复定时器；
没有修改 Mac 的物理网络。名义恢复定时为 90 秒，networkd 记录实际 down→up/IPv4 恢复为
04:08:51→04:10:32 UTC，约 101 秒（systemd 定时器调度不等同于精确时长）。
测试过程与真实服务分别运行，不依赖已断开的 SSH 会话来执行恢复。

| 阶段               | 实际观察                                                                        |
| ------------------ | ------------------------------------------------------------------------------- |
| 故障前             | live/ready 均为 true；delivered=8，pending/leased/dead=0，spool=0               |
| 网络断开           | live=true、ready=false；两次发送前后均确认网卡 down                             |
| 真实主动文本、文件 | 两次控制请求均返回 `queued`；pending=2，spool=1                                 |
| 网络恢复           | ready=true，但 delivered 仍为 8，dead=2，spool=0                                |
| 结论               | **失败**：已接受的两条消息未在恢复后送达。不能以 WebSocket 重连成功代替投递恢复 |

两条记录均 `attempts=5`，错误分类为 transport-disconnected；04:09:57 接受，04:10:13 进入 dead，
约 15.3 秒耗尽五次预算。Gateway 全程 `NRestarts=0`，缺陷不应归咎于服务被重启。

失败报告保留在专属客体 `/var/lib/wecom-agent-gateway/network-recovery.json`（0600）；
只包含平台、计数、状态，不含消息/会话 ID 或凭据。后续修复重试需保存原失败报告，不能覆盖失败证据。

本次独立主审先修正了测试脚本自身的假通过风险：必须确认发送期间仍断网、返回 queued、
有持久积压和媒体 spool；最终还需匹配测试消息的 outbox 与客户端可见结果，不能仅用全局 delivered 增长。
Lima 的旧 SSH multiplex 连接在断网后失效，使用该 VM 的独立 SSH 连接读取报告；
关闭专属 stale master 恢复了 `limactl shell`，没有重启 Gateway 或伪造其网络恢复。

## 依赖安装边界

Pi 0.84.2 与 Node 22.23.2 在服务用户下实际运行。最终 lock 与合并代码 SHA256 一致。
Claude 0.3.260 / Codex 0.153.2 的 Linux ARM64 可选原生包在本 VM 安装时失败；
官方完整 tarball 已与 lock 中 SHA512 核对，但离线 store 索引没有恢复 registry 安装。
冻结安装 exit 0 不等于这两个 Kernel 已可用，本轮不认证其 Linux 真实运行。

## 修复后第二轮：持久恢复通过，自动网络恢复未通过

代码 `d2768a0` 加入 [claim 前健康门](offline-delivery-budget.md)，不改 Store/协议/schema，
不重新实现官方 SDK 重连。主审独立全量 CI：40 文件、382 项通过；部署文件 SHA256 与审查版本相同。
修复后普通私聊的客户端结果及九项 ingress 检查通过。

首轮服务停止后，原数据库完整移动为 `gateway-failed-1.db`，原失败报告保留；第二轮使用独立空数据库。
这是测试隔离，不是删除死信来制造成功；原 macOS 生产数据库未修改。

- 04:21:23 UTC 再次断开客体网卡，两条真实消息 queued，pending=2、spool=1。
- 第 91 秒定时器实际成功执行；networkd 确认 link up、DHCP 恢复同一地址。
  但 Lima usernet 到该客体仍报 `no route to host`，Gateway 最终仍 ready=false。
  未发现 OOM 日志。不能称定时器失效，也没有足够证据确定 usernet 异常根因。
- 04:25:28 UTC 测试报告 `passed=false`，但 pending=2、dead=0、spool=1，投递预算和媒体仍保留。
- 正常停止/启动专属 VM（未 force、未删盘），再启动原 Gateway 后，两条自动送达；
  客户端可见唯一文本和 `linux-recovery.txt`（201B）。按测试标记精确关联的 outbox 各一条，
  均 delivered、attempts=1。

第二轮报告 `network-recovery-2.json` 原样保留。它证明真实跨 VM 重启后的队列/媒体耐久恢复，
**不证明此次网卡故障无需人工恢复**。因此下一轮采用专属客体内出站网络阻断，保留 SSH/DHCP，
单独验证不重启 Gateway 的网络恢复投递。

## 第三轮：不重启 Gateway 的真实出站故障恢复通过

04:34:26–04:36:49 UTC，在专属客体使用唯一临时 nftables table 阻断 TCP 80/443/7897，
不改宿主、防火墙既有规则、SSH 或 DHCP；独立 systemd 定时器 120 秒后删除该 table。
实际计数器观测到丢包。所有 nft 查询错误按失败处理，不把查询异常解释为规则已清理。

| 阶段         | 实际观察                                                                      |
| ------------ | ----------------------------------------------------------------------------- |
| 故障前       | ready=true、delivered=6、pending/leased/dead=0、spool=0                       |
| 04:35:39     | 官方连接状态变为 ready=false、live=true；阻断规则仍存在                       |
| 阻断期间发送 | 文本与文件均 queued；两次发送前后规则都在；pending=2、spool=1                 |
| 04:36:49     | ready=true；两条测试记录各 delivered、attempts=1；pending/leased/dead/spool=0 |
| 进程与清理   | PID 601、NRestarts=0、InvocationID 全程一致；专属 table 已删除                |
| 客户端核验   | 唯一标记文本与 `linux-egress-3.txt`（201B）均在授权私聊可见                   |

精确按本轮时间/标记/文件名匹配两条 outbox，不用全局计数替代关联证据。
服务端报告 `/var/lib/wecom-agent-gateway/egress-recovery-3.json` 为 passed=true、cleanupSucceeded=true；
客户端可见性由独立原生 GUI 核验，不是该 JSON 自己证明。
这证明的是**已知离线状态下接受的真实文本/媒体排队及恢复投递**，不是所有网络故障、未知 ACK 或生产负载认证。

## 首个 24 小时窗口：旧门观察结束，不作为 v3 认证

**2026-09-08 审查补充：** 当前采集器存在中途 spool 读取异常未可靠拒绝、空 journal 仍可通过的遗漏，
详见[复核记录](soak-closure.md)。旧报告没有保存足以追溯前者的字段，即使最终 passed=true，
也不能追认为修复后的严格认证。当前窗口及失败证据保留；不热改或重启其采集器。
结束后用主审通过的新采集器启动独立完整窗口，不能将两轮拼接。下列原定最早结束时间不是认证承诺。

前三轮故障实验结束后，才于 **2026-09-07 12:37:55 Asia/Shanghai** 启动真实窗口；
最早完成时间为 **2026-09-08 12:37:55**，不能把准备和故障实验的时长计入。
`wecom-soak-20260907.service` 使用实际 `wecom-agent-gateway.service`，24 小时、30 秒采样，
输出为 `/var/lib/wecom-agent-gateway/evidence/linux-systemd-soak-20260907.json`。
观测服务与 Gateway 分离，读取限定服务 journal、live/ready、Outbox/spool/磁盘与进程代际。

启动时实际 unit 为 active/running，Bot ready；这只证明已开始，不是通过。
同一 Bot 此期间由 Linux 单实例运行，macOS 服务停止；代码/配置/进程代际在窗口内固定。
已安排当前任务的自动跟进，正常状态保持安静；完整报告后做最终真实消息、文档与原 macOS 服务恢复。
Mac 使用一次性、最长 25 小时的防休眠进程，不更改永久电源设置；断电/合盖/宿主重启仍可能中断实验。

短 soak、启动命令成功、模型检查通过均不能代替 `certifying=true` 且 `passed=true` 的完整真实时钟报告。
这是低负载维护者 VM，不是容量测试。原生视频、引用真实回调、Claude 本人登录和宿主物理断网不由本实验覆盖。

### 9 月 8 日完整旧报告

旧采集器已自然结束，没有为读取报告重启 Gateway。原 JSON 原样保留，SHA256 为
`862bb304e121c4cb27e939b42f5df323c4f5bf6b2a05b444621eb4a478c8e640`。

| 观测        | 旧报告实际值                                                              |
| ----------- | ------------------------------------------------------------------------- |
| 起止 UTC    | 2026-09-07T04:37:55.553Z → 2026-09-08T04:37:55.600Z                       |
| 时长 / 采样 | 86,400,047ms / 2,877 次                                                   |
| 最大间隔    | 30,479ms，旧门允许 40,000ms                                               |
| 服务 / 健康 | inactive、PID/Invocation 变化、restart delta、live/ready/metrics 失败均 0 |
| journal     | 9 条、1 个 invocation；不代表日志完整性已认证                             |
| 投递 / 媒体 | peak pending/leased、final pending/leased/dead/spool 均 0                 |
| 磁盘低水位  | 7,403,843,584 bytes                                                       |
| 结论        | schema v2 自报 passed=true；仅旧门低负载观察，不追认为 v3 严格认证        |

本轮没有新增客户端消息测试，也不把全天零积压解释为处理了持续生产流量。

## 新 v3 独立窗口：运行中

**9 月 9 日更新：本节为启动时记录，窗口现已结束。原 v3 自动报告 failed，有限独立补证、真实客户端收尾
及日常实例恢复见[收尾记录](linux-soak-closure-2026-09-09.md)。保留标题以兼容既有历史锚点。**

主审修复已由 PR #65 合并（`4023bc3`，原审查提交 `96a5ff6`）；启动前再次完整 CI，
40 文件 / 389 项及格式、类型、公开检查通过。仅新增独立采集脚本，未覆盖旧脚本或 Gateway 源码：

- 脚本 `/app/scripts/linux-soak-v3-20260908.ts`，SHA256
  `11646c6113d0fdecf3da91045f64f2b2747f23a891a19855f8cae7bddb7c98c7`，本机和客体一致。
- unit `wecom-soak-v3-20260908.service` 于 **2026-09-08 13:03:11 Asia/Shanghai** 启动。
  最早 **9 月 9 日 13:03:11** 后才可能完成，以报告实际起止时间为准。
- 输出 `/var/lib/wecom-agent-gateway/evidence/linux-systemd-soak-v3-20260908.json`；独立 24 小时、
  30 秒采样，不启用 non-certifying 或 expect-network-outage，不拼接旧轮次。
- 采集进程初始 PID 22746、启动单调时间 88,514,413,058 微秒；
  05:03:11.495Z 客体 uptime 为 88,514.85 秒，关闭时需核对同一 boot 的真实单调经过时长。
- Gateway 仍为 PID 601、NRestarts=0，起始单调时间 68,657,338 微秒；Core SHA256 仍为
  `9e9c8efa348ca62ba634b266c50a3de0a3b79a9f1d2297c891825417f205147b`。未部署后续卡片修复，
  未重启服务或建立第二个 Bot 连接。开始时 live/ready=true，工作/积压/dead/spool=0。
- 原一次性防休眠 job 重新计时 25 小时，仍无 KeepAlive、不改永久电源。
  宿主启动时使用电池，已提示需插电勿合盖；电量耗尽或休眠不是可忽略的采样空洞。

完整报告必须为 schema v3、资源失败采样为零且全部判据通过，再独立验证客户端收发和单实例切回。
自动跟进已切换到新 unit、路径和时间。当前仅证明新采集器开始运行，**严格验收尚未通过**。
