# 生产部署基线

本页覆盖单实例 Linux/systemd 和容器参考部署。它们运行同一个 Gateway、官方企业微信 SDK、SQLite
Outbox 和所选 Kernel Adapter；不会把 Agent 逻辑移进 Channel。

## 共同要求

- Node.js 22、pnpm 11.8.0；
- 私有 `.env` / EnvironmentFile 权限 `0600`，只属于本地操作者或 system manager；
- `data`、媒体 spool、Agent 输出根目录和必要 Kernel workspace 使用持久磁盘；
- 一个 Bot 只运行一个 Gateway 实例；进程级 owner lock 会让同一锁目录中的第二实例快速失败，但当前
  尚未声明跨主机共享所有权、SQLite 多实例或全局顺序；
- Kernel 凭据、Bot Secret 和内部 allowlist 不进入镜像、unit、Compose 文件、日志或指标；
- 部署前执行 `pnpm doctor`，需要真实 Kernel 探测时执行 `pnpm doctor:live`。

## 可靠性与隐私配置

- `WECOM_SDK_MAX_RECONNECT_ATTEMPTS=-1`：普通断网持续重连；
  `WECOM_SDK_MAX_AUTH_FAILURE_ATTEMPTS=5`：错误凭据有限重试后退出，交给服务管理器告警/重启。
- `WECOM_WEBSOCKET_URL` 仅用于官方支持的私有部署端点，只接受不含 userinfo/query/hash 的
  `wss://` URL；凭据仍通过独立配置传入。
- `GATEWAY_STORAGE_RETENTION_MS=2592000000` 默认保留终态记录 30 天，按
  `GATEWAY_STORAGE_PRUNE_BATCH_SIZE` 有界删除；pending、leased、dead 以及未恢复交互不会被清理。
- `GATEWAY_LOG_SDK_MESSAGES=false`、`GATEWAY_LOG_ADAPTER_STDERR=false` 默认阻止原始上游诊断进入日志。
  只有短时故障排查才应开启；开启后仍需把日志视为敏感数据并及时销毁。
- `GATEWAY_OWNER_LOCK_ROOT` 应位于仅服务用户可写的持久状态目录。锁 key 只含 Bot ID 的不可逆短指纹；
  同一 Bot 的第二进程在创建 Store、Kernel 或官方 SDK 连接前退出。不要给两个部署配置不同锁目录来
  绕过保护；该锁不提供跨主机 active-active。完整边界见
  [`ADR 0026`](adr/0026-single-bot-process-ownership.md)。
- `CODEX_AGENT_ENV_ALLOWLIST`、`ACP_AGENT_ENV_ALLOWLIST`、`PI_AGENT_ENV_ALLOWLIST` 只填写对应 Kernel
  明确需要的变量名。不要加入 `WECOM_BOT_SECRET`；Gateway 不再把整个宿主环境交给 Codex 子进程。

SQLite `PRAGMA user_version` 当前为 `1`。遇到更高版本数据库会 fail closed，避免旧二进制误写新格式；
发布升级前先备份私有数据目录，并在测试副本执行 Doctor。

## Linux / systemd

参考 unit：
[`deploy/linux/wecom-agent-gateway.service.example`](../deploy/linux/wecom-agent-gateway.service.example)。

1. 创建不可登录的 `wecom-gateway` 用户，把仓库安装到 `/opt/wecom-agent-gateway`；
2. 将私有配置写入 `/etc/wecom-agent-gateway/gateway.env`，属主设为 `root:root`、模式设为 `0600`；
   systemd manager 会在降权前读取，Gateway 服务用户无需修改凭据文件；
3. 将 unit 中 `__PNPM_PATH__` 替换为 `command -v pnpm` 得到的绝对路径；
4. 若 Kernel 需要写 workspace 或专用 auth/session 目录，只把精确绝对路径加入 `ReadWritePaths`；
5. 安装后运行 `systemd-analyze verify`、`systemctl enable --now`，再检查：

```bash
pnpm healthcheck
curl --fail --silent http://127.0.0.1:9464/livez
curl --fail --silent http://127.0.0.1:9464/readyz
curl --fail --silent http://127.0.0.1:9464/metrics
```

unit 使用专用用户、`UMask=0077`、systemd `StateDirectory`、有限写目录、自动失败重启和 120 秒优雅
停机。不要为了让某个 Kernel 工作而取消全部文件系统保护；增加最小需要目录。

### 24 小时 soak 验收

在真实 Linux/systemd 主机、正式服务已 `active` 且观测端点只监听 loopback 后运行：

```bash
sudo -u wecom-gateway pnpm soak:linux -- \
  --duration-hours=24 \
  --interval-seconds=30 \
  --service=wecom-agent-gateway.service
```

验收器持续采集 systemd active/PID/restart 计数、`livez`、`readyz`、无标识符 Prometheus Outbox
聚合、媒体 spool 文件数和状态盘剩余空间；结束时只读取 journal 的时间戳与 invocation 元数据，不读取或
写入消息内容。默认报告写入私有 `data/evidence/`，模式 `0600`，只包含计数、时长和布尔判定。

认证运行少于 24 小时会直接拒绝。开发机可用 `--non-certifying --duration-hours=0.01` 验证脚本，但该结果
不得写入公开能力矩阵。若同一窗口安排宿主机 NIC/路由/DNS 中断，增加 `--expect-network-outage`；通过要求
是 systemd 与 `livez` 保持、`readyz` 至少一次下降后恢复、最终 Outbox/spool 归零且没有 dead letter。
报告中的 `externallyAttested` 固定为 `false`：脚本只能证明 Gateway 观察到的断线/恢复，维护者必须另行记录
实际执行的物理网络操作，不能用容器 namespace detach 或人为停止服务冒充宿主网络故障。

## 容器

仓库根目录提供 [`Dockerfile`](../Dockerfile)、[`.dockerignore`](../.dockerignore) 和
[`compose.yaml`](../compose.yaml)。构建上下文明确排除 `.env`、Git 历史、SQLite、日志、媒体和 Agent
输出。镜像使用非 root UID/GID 10001；Compose 默认只读根文件系统、删除全部 Linux capabilities、
启用 `no-new-privileges`，只持久化 `/var/lib/wecom-agent-gateway`。

```bash
docker build -t wecom-agent-gateway:local .
docker compose config
docker compose up -d
docker compose ps
```

基础镜像包含 Gateway monorepo，不内置 Pi/Kimi/Codex CLI、OpenClaw 服务或模型凭据。使用进程型
Adapter 时应构建派生镜像并固定其官方 Kernel 版本；使用外部 Agent 服务时，应采用经过审计的本地
代理或同网络命名空间方案。当前 OpenClaw Adapter 的 loopback 限制不会因为容器化而放宽。

2026-08-24 已在本机 Docker Desktop 实际完成 Compose 解析和 ARM64 镜像构建。镜像固定 Node 22
基础 digest，大小约 109MB，以 UID/GID 10001 运行；构建上下文不含 `.env`。禁用容器网络后仍可直接
运行固定 pnpm、tsx，并成功加载 Gateway Core 与 Observability 包，证明运行时不依赖 Corepack 下载。

观测端点只监听容器内 loopback，不发布 host port；Docker `HEALTHCHECK` 在容器内执行
`pnpm healthcheck`。远端 Prometheus 应使用同主机/同网络命名空间 collector 或受限代理，不要把
Gateway 观测端口直接暴露公网。

## 健康语义

- `livez=200`：进程还活着，不代表 Agent 可用；
- `readyz=200`：Gateway 已 running、官方 Transport 健康、全部 Adapter 健康、Store 可读；
- `readyz=503`：编排器应停止送入新工作并等待恢复或重启；
- `/metrics`：只含聚合 gauges/counters。Outbox `pending/dead`、基础设施错误和背压拒绝可用于告警。

本机已用真实 OS 子进程验证：投递在 SQLite 中进入 `leased` 后执行 `SIGKILL`，新进程等待租约过期
即可从同一数据库认领并完成投递。macOS `KeepAlive` LaunchAgent 也已在强杀 Gateway 后自动换 PID，
恢复 Pi Adapter、官方企业微信 WebSocket 鉴权、`readyz`、本地控制面和零积压 Outbox。

2026-08-25 又在隔离 Linux 容器中使用正式官方 SDK 完成网络故障验收：从容器移除唯一网络后，SDK
心跳把 Transport 标记为 disconnected，`readyz` 降为 503，进程保持存活并按 1/2/4/8/16 秒退避；
恢复网络后自动重新 authenticated，`readyz` 恢复 200。全程未发送消息，也未运行第二 Bot 实例。

同一已有 SQLite 持久卷改为 `:ro` 时，Gateway 因真实 `EROFS` 明确退出而非假 ready；恢复读写挂载
后数据库、Adapter 和官方连接均恢复。另在无网络、2MB Linux tmpfs 中持续写入 Outbox，真实容量
耗尽发生在 42 条已提交记录之后；释放预留恢复空间后数据库可重新打开，42 条均可读且无 dead。
该测试同时发现并修复了“回滚失败覆盖原始 SQLite 磁盘已满错误”的诊断缺陷。

这些容器/本机证据不冒充 systemd 或整机故障。仓库现已提供 fail-closed 的 `pnpm soak:linux` 验收器，
但当前仍需在独立真实 Linux 主机实际运行满 24 小时，并为宿主机级物理网卡/路由/DNS 中断补外部操作
记录；脚本存在不等于验收已经通过，容器 network namespace detach 也不能证明宿主网络栈或 systemd。
