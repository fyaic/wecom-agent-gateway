# 源码部署的升级与回退

当前项目从源码运行。本页提供**固定版本、单实例、显式备份**的操作基线，不是自动安装器，也不承诺任意版本之间可以直接降级。
首次部署仍按[上手指南](getting-started.md)；服务管理参考[部署说明](deployment.md)。

## 代码与私有状态分开

推荐由同一个服务用户管理以下目录。实际路径自行选择，不必迁移已有可用部署来完成一次代码更新。

```text
gateway-install/
  releases/<full-commit-sha>/  # 每次升级一个独立 checkout 与 node_modules
  shared/
    gateway.env               # 私有配置，0600；不在 Git 中
    workspace/                # Agent 工作区，独立于代码版本
    state/                    # SQLite、媒体 spool 与本地 control socket
    owner-locks/              # 所有版本共享，同一 Bot 不能绕过本机锁
  backups/<upgrade-id>/       # 停机时取得的配置与持久状态一致性快照
```

每个服务定义的 `WorkingDirectory` 和启动脚本指向一个**具体 release 路径**。不在正在运行的 checkout 中执行 `git pull` 或安装依赖。
这保留旧代码，但不代表旧代码仍能安全使用已经被新版本修改的数据库。

配置中的状态和工作区路径必须为绝对路径，例如：

```dotenv
AGENT_WORKING_DIRECTORY=/absolute/gateway-install/shared/workspace
GATEWAY_DATABASE_PATH=/absolute/gateway-install/shared/state/gateway.db
GATEWAY_MEDIA_SPOOL_ROOT=/absolute/gateway-install/shared/state/media-spool
GATEWAY_OWNER_LOCK_ROOT=/absolute/gateway-install/shared/owner-locks
GATEWAY_CONTROL_SOCKET=/absolute/gateway-install/shared/state/gateway-control.sock
```

同时检查 Adapter 专用 workspace、媒体输出目录、外部 Adapter 模块路径等配置；不能只改上述五项。
相对代码路径（例如内置 Echo 模板）应随 release 解析；用户工作区、私人凭据和持久状态不应随 release 改变。
OpenClaw 自身工作区不受 `AGENT_WORKING_DIRECTORY` 管理，Kernel 的认证和会话目录也需要独立保留。

Linux 服务继续使用绝对 `EnvironmentFile`。手动运行公开 pnpm 命令时，可在新 release 中建立 `.env` 到同一私有配置的链接，**不使用 `ln -f`**：

```bash
ln -s /absolute/gateway-install/shared/gateway.env /absolute/gateway-install/releases/FULL_SHA/.env
```

已有文件或悬空链接都应报错后人工核实，而非覆盖。不要对已有部署重新运行 `onboard`、注册新 Bot 或复制另一个 Kernel 的认证文件。
备份目录和 shared 目录只允许服务操作者访问；不要把快照、环境文件或原始日志上传到 Issue。

## 升级顺序

1. **记录基线。** 记录旧完整 commit、Node/pnpm、Adapter/Kernel 版本、服务定义以及当前配置路径。
   查看发布说明、依赖与许可证变化。选择经过审核的 tag 对应完整 commit，或明确选定的完整 commit；不要把 `main` 当作不可变版本。
2. **准备新目录。** 在独立目录 checkout 选定 commit，验证 `git rev-parse HEAD` 与记录相同，执行 `pnpm install --frozen-lockfile`。
   不复制旧 `node_modules`，不运行连接生产 Bot 的 smoke。此时可执行 `pnpm demo` 验证无凭据 Core 链路。
3. **准备停机。** 通知维护窗口，停止新增业务请求，确认是否有正在运行的任务、审批及 Outbox 积压。
   正常应等待排空；未排空时记录恢复与重复投递风险，不能把重启当作清空队列。
4. **真正停止旧实例。** 使用原服务管理器停止，并确保自动重启已受控、旧 PID 已退出，Bot 没有其他 Gateway/插件连接。
   手动启动的实例也必须退出；不能以 `readyz` 失败替代进程已停止确认。保留同一 owner-lock 路径，不绕过锁。
5. **取得一致性快照。** 在全部 SQLite 写入者停止后，将私有配置、完整 state（包括仍存在的 `-wal` / `-shm`、媒体 spool）、服务定义和版本清单备份到新的专用目录。
   Kernel 若另有写入进程，需按其官方备份方法处理会话数据；Gateway 数据库中的 session ID 不是 Kernel 会话本体。
   **禁止服务运行时直接 `cp gateway.db`**；也不只复制数据库而遗漏它引用的媒体文件。workspace 的备份策略单独确认。
6. **检查新版本。** 将新 release 接到同一私有配置，执行 `pnpm doctor`；如需检查数据库兼容性，只在快照的测试副本上用新版本验证，不让预检修改唯一备份。
   Doctor 不是数据库迁移认证，也不证明真实 Bot/Agent 可用。带凭据的 Agent 检查需另行安排。
7. **切换单实例。** 修改服务的具体 release 路径；同步其文件系统白名单（systemd `ReadWritePaths` 等），重新加载服务定义，启动新实例。
   检查 readiness、日志中的脱敏错误、Outbox 状态，再完成一次授权测试会话的收发/续接。健康检查正常不等于端到端已通过。
8. **保留回退材料。** 记录新 commit、切换时间、验证结果与备份位置。验证完成之前不删除旧 release 和停机快照。

不要把未经过部署的 commit 写成已发布版本。本步骤不自动发布 GitHub Release，也不自动更改服务或授权。

## 回退不是简单切回旧代码

当前 SQLite Store 使用 schema 版本检查：旧代码遇到更高 `PRAGMA user_version` 会拒绝打开。
**相同 schema 数字也不证明跨 commit 的字段含义、队列命令或 Kernel session 格式兼容。** 不修改版本号来绕过保护。

当新版本失败时：

1. 停止新实例，保留失败日志与升级后的完整状态；不要让两套实例竞争 Bot。
2. 查明失败发生在写入前还是写入后，并查阅该版本明确的回退兼容说明。没有兼容证据时，不让旧二进制直接打开升级后的状态。
3. 若选择恢复停机快照，先将失败状态保留到单独目录，再将快照恢复到**新的空目录**。保持私有权限与配置一致性，明确修改配置指向恢复后的路径。
   使用原来的 Kernel workspace/认证路径前，确认 Kernel 自身升级和会话格式是否也可回退；不要自动覆盖用户 workspace。
4. **恢复快照会丢失快照之后的会话与去重记录，并可能重新发送当时尚未完成、实际上后来已经送达的 Outbox 消息。**
   人工核对这一时间段与未完成队列，决定接受、补偿或继续修复新版本；快照无法撤回已经发出的消息，也不提供 exactly-once。
5. 只有确认数据与业务风险后，才将服务切回旧完整 commit、启动一个实例并复验。禁止监控脚本因为一次健康失败就自动还原数据库。

## 可运行的无凭据演练

```bash
pnpm test:release-layout
pnpm exec vitest run scripts/check-release-layout.test.ts
```

脚本不接受路径参数，不启动 Bot、模型、服务或子进程，不读取生产 `.env`，只在自己创建的临时目录操作并清理。
它调用真实配置生成器和 SQLite Store，验证：

- 两个 release 目录共享配置，`0600`、workspace 与配置内容保持，重复生成和悬空 `.env` 均拒绝覆盖；
- 关闭全部数据库句柄后复制完整 fixture state，同版本 reopen 保留去重和 session；
- 从快照恢复到新目录后保留 session、去重、待投递记录、媒体文件，同时证实快照之后事件不在恢复数据里；
- 较新 schema 被当前 Store 拒绝。

证据标记为 `local-fixture-no-bot-no-model`。这是**当前版本的冷备份与目录布局演练**，没有执行两个不同 release、服务切换、真实升级迁移或真实消息重放。
陌生用户首次上手、具体版本之间升级/回退、宿主故障和真实消息恢复仍需分别验收，不能用这五项 fixture 通过替代。
