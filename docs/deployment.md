# 生产部署基线

本页覆盖单实例 Linux/systemd 和容器参考部署。它们运行同一个 Gateway、官方企业微信 SDK、SQLite
Outbox 和所选 Kernel Adapter；不会把 Agent 逻辑移进 Channel。

## 共同要求

- Node.js 22、pnpm 11.8.0；
- 私有 `.env` / EnvironmentFile 权限 `0600`，只属于本地操作者或 system manager；
- `data`、媒体 spool、Agent 输出根目录和必要 Kernel workspace 使用持久磁盘；
- 一个数据目录只运行一个 Gateway 实例；当前尚未声明共享 SQLite/多实例全局顺序；
- Kernel 凭据、Bot Secret 和内部 allowlist 不进入镜像、unit、Compose 文件、日志或指标；
- 部署前执行 `pnpm doctor`，需要真实 Kernel 探测时执行 `pnpm doctor:live`。

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

这些容器/本机证据不冒充 systemd 或整机故障。当前仍需在真实 Linux 主机完成 systemd 长时间运行和
宿主机级物理网卡/路由中断；容器网络 namespace detach 不能证明宿主网络栈、DNS 或 systemd 行为。
