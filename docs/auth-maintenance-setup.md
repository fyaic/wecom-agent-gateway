# 为自己的 Bot 配置授权维护

这一步把**已有 Gateway Bot** 与本机 [wecom-auth-keeper](auth-keeper.md) 对齐，生成独立私有配置。
不创建新 Bot，不修改原 Gateway `.env`、原 Keeper 配置或 Keeper 仓库，也不读取 CLI 凭据。
它不会安装常驻服务、发消息、点击授权或开启定时任务；生成后的维护开关默认关闭。

Gateway 的 SDK 消息连接与 CLI 办公能力授权是两层：授权维护针对后者，不能把页面授权成功当作消息链路或业务 API 的成功证明。

此处的 CLI 能力也包括「发送消息」，但它不等于 SDK 聊天链路。若只维护 CLI 消息能力，使用下面示例的
`targetRows: ["发送消息"]` 即可；未列出的文档、邮件、通讯录等权限保持原状，不自动续期、申请或撤销。
示例不是自动默认：生成器要求每位部署者显式选择非空白名单。只用 SDK 聊天的用户可以跳过整项插件。

## 人工前置条件

- 在 macOS 企业微信桌面登录自己的账号，确认这个账号有权管理目标 Bot 的指定能力。
- 按 Keeper 自身指南安装 Python 环境、依赖并授予必要系统辅助功能权限。这些登录和系统权限不能由生成器绕过。
- 已有可用 Gateway `.env`，其中 `WECOM_BOT_ID` 指向你的 Bot；不要借用维护者的 Bot、测试成员或内部配置。
- 从该 Bot 的官方权限页面取得已有 `authorizationList` 链接。链接应属于 `https://work.weixin.qq.com/ai/aiHelper/authorizationList`，含 `aibotid` 和 `str_aibotid`。
  不要自行猜测 ID，不要执行 `auth init` 来获取第二个 Bot，也不要把完整链接发到 Issue。
- 确定只允许维护哪些能力。这里只接受显式、非空、不重复的官方能力名称，不支持通配符或“授权全部”。

## 1. 用本地编辑器准备私有输入

在 Git 仓库之外保存一个 JSON 文件，例如 `/absolute/private/auth-maintenance-input.json`。
用编辑器填写链接，**不要将链接、Bot ID 或 JSON 内容直接写入终端命令参数**，避免留在 shell history。

```json
{
  "gatewayEnvPath": "/absolute/gateway/.env",
  "authorizationUrl": "<将自己 Bot 的已有官方授权链接粘贴到这里>",
  "botChatName": "<自己 Bot 的会话名称>",
  "targetRows": ["发送消息"],
  "keeperRepositoryPath": "/absolute/wecom-auth-keeper",
  "keeperPythonPath": "/absolute/wecom-auth-keeper/.venv/bin/python3"
}
```

六个字段必须全部填写，不接受其他字段。所有路径必须为绝对路径；不支持含单引号、换行或 NUL 的路径。
`keeperRepositoryPath` 必须已有 `renew.py`；Python 路径必须已有且可执行，可以是 venv 的 Python 链接。
输入文件权限必须仅当前用户可读写，例如：

```bash
chmod 600 /absolute/private/auth-maintenance-input.json
```

`targetRows` 当前支持：发送消息、发送邮件、搜索与获取邮件内容、新建与编辑文档、搜索与获取文档内容、
新建与跟进待办、新建与管理日程、预约与更新会议、搜索与获取会议信息、上传与更新微盘文件、搜索与获取微盘文件内容、搜索企业成员、获取对话用户信息。
如官方未来修改能力名称，应先更新兼容性验证，不能用近似名称绕过白名单。

## 2. 生成到一个不存在的新目录

在 Gateway 仓库运行：

```bash
pnpm exec tsx scripts/setup-auth-maintenance.ts \
  --input /absolute/private/auth-maintenance-input.json \
  --output /absolute/private/my-bot-maintenance
```

输出目录的父目录必须已经存在。输出目录本身必须不存在，也不能是文件、现有目录或悬空链接；不提供覆盖开关。
输出不能放入 Keeper 仓库。避免放入任何 Git 仓库、共享目录或 Agent 可任意写入的工作区。
失败时只输出固定错误类别，不输出链接、ID、路径、原始 JSON 或凭据。写入中断时可能留下部分输出目录；人工核实后选择新的输出目录，不自动清空旧目录。

生成内容：

```text
my-bot-maintenance/      # 0700
  keeper.json           # 0600：同 Bot 身份、能力白名单、独立状态路径
  maintenance.env       # 0600：只有 Bot ID，没有 Bot Secret
  state/                # 0700：维护状态和 Keeper 私有状态目录
```

生成器校验官方 HTTPS 域名、准确页面路径、唯一身份参数及数字 `aibotid`，并要求链接中的 `str_aibotid` 与 Gateway 的 `WECOM_BOT_ID` 完全一致。
会话名称只是辅助配置，不能替代身份校验。它只从已有 Gateway 环境文件使用 Bot ID，不复制其他字段，不读取本机 wecom-cli 认证配置。

## 3. 明确启用边界后再运行维护

新 `maintenance.env` 的关键默认值是：

```dotenv
WECOM_AUTH_MAINTENANCE_ENABLED=false
WECOM_AUTH_MAINTENANCE_PRE_RENEW=false
WECOM_AUTH_KEEPER_EXISTING_WINDOW_ONLY=false
WECOM_AUTH_MAINTENANCE_INTERVAL_MS=3600000
WECOM_AUTH_KEEPER_WITHIN_HOURS=24
```

- **默认没有自动授权。** 先检查独立配置、系统前置条件及同一 Bot 身份，再明确开启维护。
- `EXISTING_WINDOW_ONLY=false` 只允许 Keeper 使用其现有的**可见官方授权链接**导航能力；不是任意搜索聊天、打开网页或控制桌面的许可。
  当前仍可能需要你提前打开正确权限页，或让正确 Bot 的授权链接出现在可见聊天区域。生成器不会发送入口链接。
- `PRE_RENEW=false` 不会为了延长授权先撤销有效权限。预续期是另一项明确选择，且始终要求已有的目标授权窗口；不能因普通续期失败而自动转成预续期。
- `bridge_send_link` 和 `bridge_monitor` 均为 `false`；不会自动调用另一个 Bridge 发消息或修改监控模式。
- 白名单中的授权控件可能同时用于“已到期”与“从未授予”的能力。生成器不授予任何能力，但启用后允许恢复的范围就是该白名单；不要加入不准备授予的权限。

具体检查、维护模式及状态语义以[授权恢复指南](auth-keeper.md)为准。使用新环境文件时，明确指定它，不将其内容合并覆盖 Gateway `.env`。

最后仍需核对 **wecom-cli 当前凭据是否属于同一个 Bot**，再执行对应能力的业务验证。
GUI 页面恢复不等于 CLI 凭据身份已对齐，也不等于文档写入、通讯录查询等所有业务都恢复；不要自动重试先前结果不明确的业务写操作。

已有 Bot 的 CLI profile 配好后，在独立 `maintenance.env` 添加专属 `WECOM_CLI_CONFIG_DIR`、
`WECOM_CLI_TMP_DIR`、`WECOM_CLI_LOG_DIR`，可运行 `pnpm auth:probe --env-file /absolute/private/maintenance.env`
验证同 Bot 的最近会话查询。它不自动创建 profile、不发送消息、不检查其他办公能力；
具体约束见[只读能力探针](auth-keeper.md#同-bot-的独立-cli-能力复探)。

## 4. 可选：macOS 登录会话中常驻

仓库提供[LaunchAgent 模板](../deploy/macos/com.fyaic.wecom-agent-gateway.auth-maintenance.plist.example)，
**只供明确选择后安装，不由生成器安装或启用**。它与 Gateway 主进程独立，不连接 Bot WebSocket。
请先完成前述单次检查及同 Bot 验证，再考虑常驻；不要同时运行手动 `watch` 和此 LaunchAgent。

### 准备私有副本

1. 用编辑器将模板另存到当前用户的 `Library/LaunchAgents/com.fyaic.wecom-agent-gateway.auth-maintenance.plist`，
   已有同名文件时先检查，不能覆盖另一部署。不是系统 LaunchDaemon，不使用 `sudo` 安装。
2. 将 `__NODE_PATH__` 替换为符合项目版本要求的 Node **绝对路径**；`__PROJECT_DIR__` 为已安装依赖的 Gateway checkout 绝对路径；
   `__MAINTENANCE_ENV__` 为本节生成的独立环境文件绝对路径；`__PRIVATE_LOG_DIR__` 为独立日志目录绝对路径。
   路径里的 XML 特殊字符须按 XML 转义，不使用 `~`、shell 变量或命令拼接。
3. 日志目录须预先创建并设为 `0700`，环境文件和 plist 设为 `0600`，均由登录用户拥有。
   它们放在 Git 与 Agent 可写工作区之外，不与 Gateway 日志混用；自行安排日志轮转和保留期限。
4. 确认 `maintenance.env` 仍为 `WECOM_AUTH_MAINTENANCE_ENABLED=false`，先执行以下语法检查。
   示例中的 `/absolute/user` 与 `/absolute/private` 都应替换成自己的实际路径：

```bash
chmod 600 /absolute/user/Library/LaunchAgents/com.fyaic.wecom-agent-gateway.auth-maintenance.plist
plutil -lint /absolute/user/Library/LaunchAgents/com.fyaic.wecom-agent-gateway.auth-maintenance.plist
```

模板直接以 Node `--import tsx` 启动 worker，不使用 shell、pnpm 包装器或 Gateway `.env` 自动加载。
`WorkingDirectory` 用于解析已安装的 `tsx`；移动 checkout 或切换 Node 路径后应同步更新私有 plist。

### 显式加载、启用与停止

以下命令是**部署者明确选择执行的操作**，不是安装包自动运行的步骤：

```bash
# 在当前已登录的图形用户会话注册；默认 disabled 时只输出状态并成功退出。
launchctl bootstrap gui/$(id -u) /absolute/user/Library/LaunchAgents/com.fyaic.wecom-agent-gateway.auth-maintenance.plist
launchctl print gui/$(id -u)/com.fyaic.wecom-agent-gateway.auth-maintenance
```

默认 disabled 的预期是退出码 `0`、没有存活 worker，也没有 GUI 操作；注册成功不证明授权恢复。
确认策略后，在私有环境文件中显式改为 `WECOM_AUTH_MAINTENANCE_ENABLED=true`，保留不需要的预续期开关关闭，
再运行：

```bash
# 从已注册且退出的状态开始；首轮可能检查或恢复白名单授权。
launchctl kickstart gui/$(id -u)/com.fyaic.wecom-agent-gateway.auth-maintenance
```

需要停止或更新配置时：

```bash
launchctl bootout gui/$(id -u)/com.fyaic.wecom-agent-gateway.auth-maintenance
```

环境文件只在 worker 启动时读取。**修改为 disabled 不会立即停止正在运行的 worker**；先执行 `bootout` 并确认退出，
然后编辑文件，需要重开时再 `bootstrap`。停用时保留私有配置和状态，不自动删除授权记录、凭据或日志。

### 运行边界

- **终端交互式通过，不等于 LaunchAgent 可以访问辅助功能。** macOS 可能按实际宿主/启动上下文分别判断辅助功能权限；
  已授权终端或 Codex，并不能证明 launchd 启动的 Node/Python 路径也被允许。`doctor` 只检查本地前置条件，不验证实际 GUI 访问。
  应在最终的后台启动上下文核对第一轮检查结果；若辅助功能权限不可用，由用户在系统设置中检查实际执行进程的授权，再按停止/重启流程复查。
  不重置系统隐私数据库、不绕过系统授权、不把脚本改成另一宿主来规避限制。未通过后台检查前，部署状态仍是未验证或需人工处理。
- 后台前置条件失败会保留固定诊断：`accessibility-permission-unavailable` 表示执行上下文未获辅助功能信任；
  `wecom-not-running` 表示未发现企业微信进程；`wecom-window-unavailable` 表示发现进程但没有可访问窗口，**不能据此断言一定是权限缺失**；
  `wecom-multiple-instances` 表示多个有窗口的企业微信实例，需先由用户确认目标实例。这些失败不会触发授权点击或被标为业务恢复。
- 仅加载到当前用户的 `Aqua` 图形会话；仍要求企业微信桌面已登录、相关系统权限可用，并有正确权限页或可见授权链接。
  登录项不是桌面导航自动化，也不保证注销、睡眠、锁屏或界面变化期间可用。
- `KeepAlive.SuccessfulExit=false` 仅在异常/非零退出后重启，最少节流 60 秒；disabled 和正常停止的成功退出不会形成重启循环。
  `watch` 的单轮 `needs-attention` 会继续按维护间隔运行，不靠 launchd 无限快速重试授权；持续错误仍需操作者处理。
- `Umask=63` 是十进制表示的 `0077`。stdout/stderr 分别写入私有目录，但第三方诊断仍应视作私密数据，不直接上传日志。
- `ExitTimeOut=360` 给停止信号后的在途检查/恢复/复查留出时间；worker 会等待当前轮结束。
  不随意强杀或删锁。如果系统强制中止，应先核实页面状态与持久意图，再决定恢复，不能假设授权动作没发生。
- 模板和测试不构成实机常驻或跨真实授权周期认证，不承诺无人值守。`status`、GUI 页面及业务 API 的证据仍分层判断。

### 最近检查、动作与日志

```bash
pnpm auth:maintenance status --env-file /absolute/private/my-bot-maintenance/maintenance.env
```

`status` 只读本地状态，不检查 GUI、不调用业务 API、不续期。它返回的历史快照**不是当前健康状态或 worker 心跳**；
判断进程是否仍运行应另看 `launchctl print`，并比较最近检查时间与维护间隔。
旧版状态没有历史字段时，表示尚无这类证据，不代表从未执行或始终健康。

| 字段                                     | 作用与边界                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `lastCycle.startedAtMs` / `finishedAtMs` | 最近一轮的实际墙钟起止时间（Unix 毫秒）；退避轮也记录，但不代表检查过页面。                                       |
| `lastCycle.before` / `after`             | 本轮首次检查和动作后独立复查摘要；无复查或退避时对应字段缺省，不编造“已检查”。                                    |
| `lastInspection.checkedAtMs`             | 最近一次实际检查尝试的时间；退避不会刷新，检查失败记 `unavailable`，不沿用旧的健康结论。                          |
| `lastAction`                             | 最近一次尝试执行的续期动作及结果；不会被后续无动作的健康轮覆盖。`action` 区分 `renew` 与主动撤权式 `pre-renew`。  |
| `providerCode`                           | 固定白名单诊断，例如目标页未打开、目标链接不可见、页面不完整或配置已变；未知诊断收敛为 `inspection-unavailable`。 |
| `pendingIntent` / `locked`               | 未确定结果的动作意图、当前/异常遗留锁。先调查，不按锁年龄自动清除，也不盲目重新授权。                             |

`status` 顶层 `businessVerified` 始终是 `false`，因为读取历史没有重新验证业务；嵌套字段即使为 `true`，
也仅描述当时 provider 真正验证过的能力，不扩展为所有办公能力可用。
当前 Keeper 的页面检查不做业务 API 验证，所以页面恢复后仍应运行同 Bot 的独立只读探针。

worker 的私有 JSON stdout 在状态变化或每次动作后保留本轮固定结构的 `cycle`，包括前后摘要与起止时间。
连续相同的健康轮不刷屏；连续动作即使结果相同也各自留一条记录。**最新状态会被后续轮更新，保留私有日志才能复核先前的恢复事件**。
这些输出不含原始页面、Bot ID、链接、姓名、凭据或原始异常，但含运行/到期时间，应按私密运行证据保存。
自行轮转前先保留待验收时间段；不要直接把原始日志上传到公开 Issue。

## 5. 跨真实到期周期的验收

自动化测试已覆盖假的到期/恢复、失败退避、停止时等待在途恢复、释放自己持有的锁、重启后不重复动作、历史证据与敏感内容拒绝输出。
这些测试只证明实现行为，不证明真实企业微信授权自然到期后可无人值守恢复。实际验收应独立保留以下证据：

1. 记录所用 Gateway / Keeper 版本、维护间隔、权限白名单及显式开关；不要记录 Bot ID、完整链接或凭据。
   起始检查须为同 Bot 的真实健康页面，记下真实到期时间；保留 `PRE_RENEW=false`，本次观察期间不主动撤权、不手动续期、不修改系统时间。
2. 在已登录桌面会话中等待真实墙钟越过到期时间。保留私有 stdout 原始记录；应实际观测到本轮 `before` 为到期，
   `action=renew`，随后 `after` 为同身份健康、没有待恢复意图，并在有到期字段时确认期限已延长。
   单有一次 `renewed` 或 GUI 健康不足以证明这是自然到期恢复。
3. 另行运行同 Bot 的只读业务探针，独立保留其执行时间与脱敏结果；目前 `auth:probe` 只验证最近会话查询。
   其他能力未被验证就保持未验证，不用该探针给文档/邮件/微盘等能力背书。
4. 后续至少一轮仍健康且 `action=none`、没有待恢复意图或遗留锁，`lastAction` 仍指向此前那次动作，核对未重复续期。
   检查日志中的时间顺序、退避和进程启停记录，再给出“这个真实到期周期已通过”的结论。

如期间发生睡眠、注销、页面入口丢失、配置改变或缺失日志，应记录实际缺口；不能据此宣称全程连续可用。
若只观测到到期后的某次恢复，结论就仅限该次恢复。主动撤权后再恢复、测试假时钟、补写的历史快照，都不算自然跨周期证据。
强制中断后必须先核对持久意图与真实页面；没有确切结果时保留 `needs-attention`，不要删锁制造“通过”。

## 证据边界

生成器测试覆盖身份不符、非法官方链接、能力白名单、默认关闭、私有文件权限、敏感输出控制和已有/符号链接输出拒绝覆盖。
这些是无账号本地配置测试，不是新用户真实授权认证，也不是跨周期自动续期或业务 API 恢复认证。
