# 运行排障 / Running-service triage

`pnpm gateway:status` reads the running Gateway's aggregate metrics. It does not start a Bot connection,
invoke a model, read chat history, change configuration or repair/replay deliveries.

先在服务的私有 `.env` 中显式启用已有观测端点，按正常受管服务流程重启一次：

```dotenv
GATEWAY_OBSERVABILITY_ENABLED=true
GATEWAY_OBSERVABILITY_HOST=127.0.0.1
GATEWAY_OBSERVABILITY_PORT=9464
```

然后在使用相同配置的项目目录运行：

```bash
pnpm gateway:status
```

新手最小配置仍默认不开放观测端点。未启用时报告 `disabled`，不是判定 Bot 故障。
该命令默认读取 `.env`；受管进程若注入不同端口，需要在调用时使用对应观测配置。
只支持 `127.0.0.1` / `::1`，不跟随重定向，超时 3 秒、响应上限 64 KiB。

| status / finding                             | 含义与下一步 / Interpretation                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `healthy`                                    | 当前组件 ready、没有可见工作/积压或 dead；不是端到端送达认证                                                                                |
| `busy`                                       | 组件就绪但有工作；`work-active` 是排队/运行，`approval-pending` 是等待审批，`deliveries-pending` 是出站等待或租赁中。单个快照不能判断“卡死” |
| `degraded` / `gateway-not-ready`             | 入口尚未就绪；结合其他 finding 看 Transport、Adapter、Store，启动/关闭期间也可能出现                                                        |
| `transport-unhealthy`                        | 检查 Bot 网络/认证及单进程所有权；不要再启动竞争连接                                                                                        |
| `adapter-unhealthy`                          | 检查既有 Agent 运行/认证；不要把模型问题诊断成企微网络问题                                                                                  |
| `store-unhealthy`                            | 检查本地磁盘和数据库权限；勿直接删除数据库                                                                                                  |
| `outbox-dead`                                | 存在已停止自动重试的投递，可能是历史失败；查看 `pnpm outbox:status` 并按[部署手册](deployment.md)处理，禁止盲目全量重发                     |
| `disabled`                                   | 未启用观测；按上方启用，而非自动修改服务                                                                                                    |
| `unavailable`                                | 端点无法读取/超时/HTTP 错误；查服务、配置端口和进程状态，不能只凭此断言 Bot 离线                                                            |
| `invalid-configuration` / `invalid-response` | 观测配置错误，或端点返回不完整/重复/矛盾指标；检查端口是否属于本 Gateway 和版本匹配                                                         |

输出为 schemaVersion 1 的 JSON（pnpm 自身可能另有启动提示）；`healthy` / `busy` 退出 0，其余退出 1。
报告只包含白名单字段的布尔值、计数和固定 finding，未知指标/标签/注释不会进入报告。
`delivered` 是 Gateway 记录的成功提交数量，不是用户已读数；`dead` 可能早于当前任务。
聚合数字仍可能透露使用规模，公开 Issue 前应自行检查；不要附带 `.env` 或原始聊天日志。

## 哪个命令查哪一层

| Command                           | Boundary                                                        |
| --------------------------------- | --------------------------------------------------------------- |
| `pnpm doctor`                     | 静态配置、权限和可执行程序；不验证模型回答                      |
| `pnpm agent:check`                | 独立调用配置的 Agent 两轮并验证续接，消耗其模型额度；不连接 Bot |
| `pnpm gateway:status`             | 只读运行中服务组件、工作与 outbox；不发测试消息                 |
| 授权私聊 / authorized direct chat | 真实客户端可见收发；需另验媒体与交互，不能由 health 指标替代    |

“慢”也要分层：已有 lifecycle 事件记录排队、首回执、媒体物化、Agent 首事件/首文本与终态。
它们并非全从同一时间原点计算；Prometheus duration sum/count 是进程生命周期聚合，
不能相减推导某次网络延迟，也不是 p95 或近期窗口 SLA。定位某次请求必须依赖受控本地事件关联，
不得为排障把用户正文或隐藏推理加入指标。
