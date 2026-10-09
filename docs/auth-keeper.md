# 可选的本地授权恢复：wecom-auth-keeper

Gateway 负责稳定传输；[wecom-auth-keeper](https://github.com/fyaic/wecom-auth-keeper)
负责在已登录的 macOS 企业微信桌面中检查、恢复指定 Bot 的办公能力授权。
它是独立运维工具，不是 Gateway、Agent Adapter 或 runtime-contract 的运行时依赖。
不安装它，SDK 收发链路仍可独立运行。

## 三层状态不能混为一谈

| 证据                            | 能证明什么                       | 不能证明什么                                  |
| ------------------------------- | -------------------------------- | --------------------------------------------- |
| Gateway health / SDK 收发验收   | 通信服务或被验收消息路径的状态   | CLI 办公能力授权有效                          |
| Keeper doctor                   | 本地配置、依赖和平台满足前置条件 | 桌面已登录、辅助功能已授权、任何业务 API 可用 |
| Keeper inspect / renew 页面校验 | 当前目标页面中指定权限状态       | CLI 当前凭据属于该 Bot、业务 API 已恢复       |

本包装器始终输出 `businessApi: not-verified`、`cliCredentialIdentity: not-verified`，
不把 GUI 成功变成“业务恢复成功”，也不据此覆盖 Gateway 健康状态。
`identity: configuration-matched` 表示 Gateway Bot ID 与 Keeper 配置匹配；
`page-verified` 额外表示 Keeper 已验证现有页面身份及权限行，仍不证明 CLI 凭据归属。

## 本地配置

先按 Keeper 自身部署指南安装 Python 环境及 macOS 依赖。配置保留在私有本地文件中，
不要提交 Bot 标识、授权链接、凭据、桌面截图或原始输出。

为此包装器配置以下环境变量（路径必须绝对路径）：

```dotenv
WECOM_AUTH_KEEPER_DIR=/absolute/path/to/wecom-auth-keeper
WECOM_AUTH_KEEPER_CONFIG=/absolute/path/to/private/keeper-config.json
WECOM_AUTH_KEEPER_PYTHON=/absolute/path/to/wecom-auth-keeper/.venv/bin/python3
```

`WECOM_AUTH_KEEPER_PYTHON` 可省略或留空，届时使用 Keeper 配置中的绝对 `venv_python`。
Gateway 现有 `WECOM_BOT_ID` 必须与 Keeper `str_aibotid` 完全一致，不能凭聊天名称认定同一 Bot。
配置中必须显式设置非空 `target_rows`、`bridge_send_link: false`、`bridge_monitor: false`，
以及不同的 `state_file`、`log_file`。不会修改原配置或沿用缺失开关的兼容行为。

能力白名单就是本次操作范围。Keeper 的“授权”控件不能区分曾到期和从未授权，
所以不要加入不准备授予的能力。包装器不自动添加消息、通讯录或文档权限。
配置身份不是 CLI 凭据身份：后续使用 CLI 前仍需核对其目标 Bot，不允许切换真人身份兜底。
若 CLI 当前身份属于另一个 Bot，不能使用该 CLI 的成功探针证明 Gateway Bot 的能力恢复，
也不能调用该 CLI 的写探针补测。必须先解决身份归属，再执行对应 Bot 的业务验证。

## 命令及副作用

在 Gateway 仓库目录执行：

```bash
# 默认命令：无 GUI、无业务 API 调用、无发消息
pnpm auth:keeper

# 显式查看：需要目标“可使用权限”页已经打开；不改授权，但 Keeper 会写本地状态
pnpm auth:keeper inspect

# 显式恢复：需要同一目标页面已经打开；会授权白名单中的待授权项
pnpm auth:keeper renew
```

以上手动命令调用原项目的 `renew.py --doctor`、`--check --existing-window` 或
`--renew --existing-window`。周期维护使用下述独立可选 worker，不进入 Gateway 主进程。
默认 doctor 的临时配置快照在本次调用后删除；inspect / renew 的 Keeper 状态文件会保留。
成功退出 0；未配置、平台不支持、身份不符、子进程错误或不可验证结果均非零退出。
`target-page-not-open` 要求先打开正确权限页；`permissions-unhealthy` 表示页面能力未健康；
`keeper-busy` 表示已有 Keeper 持有锁；这些状态均不会自动转成续期操作。

边界：

- 不运行 `auth init`，不会创建第二个 Bot，也不会重置现有凭据。
- 上述手动命令不运行 `--pre-renew`；周期 worker 只有显式开启预续期才允许先撤销再授权。
- 不调用 `probe.py` / `keepalive.py`；这些入口可能覆盖测试表 A1 或发送通知，不能作为无副作用探针。
- 不自动重试失败的业务写操作。授权恢复后，由调用方重新确认业务是否已发生，避免重复创建。
- doctor / inspect / renew 总超时分别为 15 / 30 / 240 秒；单次失败不自动重试。
- 身份已校验配置使用 0600 临时快照传给 Keeper，避免原配置在两次读取间切换目标。
- 子进程仅继承必要系统环境，不传 Gateway Bot secret、模型密钥或原始错误输出。
- 续期超时可能发生在点击之后；非零退出不代表没有授权变化，应重新 inspect 并核查，不盲目重做业务。

## 恢复闭环与当前证据

正确闭环是：发现**具体 CLI 能力**返回授权失效 → 同 Bot 页面身份检查 → 显式恢复 →
核对 CLI 凭据身份 → 针对该能力做业务 API 验证 → 决定原业务是否可以安全继续。
只读能力可用针对性的只读探针；写能力验证必须使用明确允许修改的专用对象。
文档读写成功不能证明通讯录、消息或其他能力也已恢复。

截至 2026-09-23，Keeper 上游记录的 9 月 22 日独立脚本实机结果覆盖文档读写及通讯录
三项页面预续期；不能外推为本 Gateway Bot 的消息权限恢复、完整导航或跨周期认证。
本包装器有 fake-backed 身份、边界、超时、异常、脱敏及配置快照测试；
**没有通过包装器执行真实 GUI 续期或业务 API 复探**。真实验收结果需另行记入验收矩阵。

## 可选授权维护插件（2026-10-08）

先按[独立用户配置指南](auth-maintenance-setup.md)生成你自己的私有配置。
`auth:setup` 不借用维护者账号、不创建 Bot、不更改 CLI 当前身份，初始维护和预续期开关均关闭。

```bash
pnpm auth:setup --input /absolute/private/input.json --output /absolute/private/my-bot-maintenance

# 只读本地状态，不碰 GUI / 业务 API；需显式使用生成的配置
pnpm auth:maintenance status --env-file /absolute/private/my-bot-maintenance/maintenance.env

# 在该私有 env 内明确设 ENABLED=true 后，单次检查并恢复指定的失效授权
pnpm auth:maintenance once --env-file /absolute/private/my-bot-maintenance/maintenance.env

# 独立前台 worker，默认每小时串行检查；停止进程即停止周期维护
pnpm auth:maintenance watch --env-file /absolute/private/my-bot-maintenance/maintenance.env
```

设置 `WECOM_AUTH_MAINTENANCE_PRE_RENEW=true` 才允许在到期前维护，阈值
`WECOM_AUTH_KEEPER_WITHIN_HOURS` 默认 24、范围 0–168；这种维护包含短暂撤权再授权，不能称无缝官方刷新 token。
正常过期恢复不自动升级为预续期。检查间隔默认一小时、最短一分钟；它是检查频率，不是每次都重新授权。
watch 不自行安装系统服务，机器休眠或进程停止时不运行；SIGINT / SIGTERM 停止后续周期，已开始的有界 GUI 周期先收尾。
若需要常驻，应由用户的 macOS 服务管理器托管，
仍要求桌面登录及辅助功能权限。Linux 用户不需要安装此插件才能使用 Gateway。

插件仅定义 `inspect()` / `renew()` 和同身份配置绑定；调度状态机不依赖原生 GUI。
实现位于 `scripts/lib/auth-maintenance-contract.ts`，当前内置 provider 只有 Keeper。
第三方 provider 可实现同一契约，但当前没有任意 npm 插件自动加载器、注册市场或热加载机制。
Agent 内核继续使用已有 `AgentRuntimeAdapter`，两类扩展互不依赖。

安全语义：

- 默认关闭不加载 provider、不触 GUI。配置身份、文件真实路径和实际读取字节摘要绑定，配置变化需要重新启动。
- 本地私有状态、原子落盘、跨进程互斥；动作意图先于授权点击写入，未知结果先检查，不盲目重复撤权。
- 页面复查可确认授权动作完成，但输出仍为 `businessVerified:false`，绝不替代同 Bot 的具体业务 API 验证。
- 同一预续期结果至少一小时内不重复触发，下一个临期窗口仍可继续预续；真实过期恢复不受该抑制影响。
  异常有退避及尝试上限。无法验证页面、身份不符、恢复未确认均给明确异常状态。
- 不重试原业务写操作，不覆盖 CLI 凭据，不改变 SDK 收发健康判定。
- 崩溃遗留锁不自动按年龄删除。先确认无 worker / Keeper 正在操作，再由运维检查锁及 pending 状态；不能用删状态方式绕过未知动作。

**现阶段不是“所有桌面状态下完全免人工”。** 原 Keeper 只能操作已打开的正确权限页，或当前可见的同 Bot 官方授权链接；
`EXISTING_WINDOW_ONLY=false` 只开放后者，不会从任意桌面搜索聊天并导航到授权页。
预续期仍强制使用已有授权窗口。页面不存在时退出/退避，不通过另一个 Bot 发链接兜底。
初始化登录、系统权限、页面入口和同 Bot CLI 凭据对齐仍是条件；跨真实到期周期尚未验收。
消息能力的后续独立实测见下节，其他办公能力仍未复探。

## 同 Bot 的独立 CLI 能力复探

新增只读命令，明确指定私有环境文件，不使用默认 CLI profile 兜底：

```bash
pnpm auth:probe --env-file /absolute/private/my-bot-maintenance/maintenance.env
```

该文件须配置 `WECOM_BOT_ID` 及三个互不嵌套的、已存在的私有绝对目录：
`WECOM_CLI_CONFIG_DIR`、`WECOM_CLI_TMP_DIR`、`WECOM_CLI_LOG_DIR`。
每次子调用重建环境，不继承外部 access token、额外请求头或服务端点覆盖。
探针顺序是 `auth show --status` → `identity whoami` → `message aibot sessions list`；
两次业务响应中的机器人身份都必须匹配预期 Bot。任一失败即停止，不执行 init、不修改 profile、不发消息。

当前 CLI 1.1.0 的身份是 `extra_identity_context` 文本，不是独立 JSON Bot ID。
探针严格接受已实测的身份段落结构；结构变化、歧义或字段缺失一律失败，不从授权真人身份猜测 Bot。
`businessVerified:true` **仅指报告中的 `capability:message-sessions`**；不证明发送成功、其他办公能力、SDK 收发或 Agent 回答。
Keeper worker 的页面报告继续独立保持 `businessVerified:false`，不会把这项探针扩大成所有能力健康。

若现有 CLI 属于别的 Bot，应使用全新的专属目录，按官方 `auth init --manual` 输入已有 Bot 凭据，
不能用默认扫码流程创建第二个 Bot，也不能在已授权的默认 profile 上重新初始化。
Secret 只通过官方密码输入框进入，不放入命令行参数、公开文件、日志或聊天。
该初始化不属于 `auth:probe` 的自动动作；普通社区用户仍需完成一次自己的配置。

2026-10-08 后续实机已验证 Gateway 同 Bot 的独立 profile、最近会话查询、授权私聊和测试群发送客户端可见，
以及权限页关闭后从**当前可见私聊链接**自动打开正确页面。
这补上上述首轮缺失的消息能力复探，但不补全其他能力或真实跨周期续期认证。
见[实机记录](reviews/auth-maintenance-live-2026-10-08.md)。
