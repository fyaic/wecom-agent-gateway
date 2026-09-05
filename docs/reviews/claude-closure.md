# Claude Code Adapter 可靠性复核

日期：2026-09-05。范围：实验性 `packages/adapter-claude-code`，不改变默认 Gateway 注册、安装入口或支持等级。

## 结论与主线关系

本轮修正 Adapter 的取消、终态与会话归属边界：这些直接影响中间层是否忠实、稳定地传递 Agent 结果，
不涉及模型选择、推理、工作流、卡片或新的认证代理。

**真实认证成功验收仍受阻，Claude Code 仍为实验性。** 本轮没有新增 Bot、模型或端到端成功证据。

## 本机认证检查（非模型测试）

- 使用仓库锁定的官方 Agent SDK `0.3.258` 随附未修改 Claude Code `2.1.258`。
- 系统 PATH 中未找到独立 `claude`；使用 SDK 随附 binary 的公开 `auth status`，不解析私有登录文件。
- 子进程只继承 HOME/PATH/USER/SHELL/TMPDIR/LANG/LC_ALL，15 秒超时；原始响应仅在进程内解析，
  输出投影为 `loggedIn: false`、`authMethod: none`。没有输出账号、邮箱、token 或原始 stderr。
- 当前进程的 `ANTHROPIC_API_KEY` 不存在；Bedrock/Vertex/Foundry 启用标志均未设置。
  这仅说明本次隔离检查没有可用认证配置，**不宣称宿主机所有位置都不存在其他凭据**。
- 没有借用其他 Agent 的凭据、搜索私有配置、复制密钥、修改登录、启动 Bot 连接或改动生产配置。
- 因认证前置条件不满足，没有运行真实两轮模型 smoke，也没有重复触发登录要求。

后续可使用已有 `pnpm smoke:claude-code-adapter -- --confirm-real-claude` 入口，
但只有部署者自有且对隔离 SDK 可用的认证准备好后，才进行真实文本、同 session 续接与取消验证。
现有 smoke 不是新凭据收集器，也没有证明真实重启恢复、WeCom 私聊/群聊、媒体或交互。

## 已修缺陷与确定性证据

| 风险                                                                            | 修正                                                         | Fake-backed 测试                                                                                                   |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| abort 后 SDK 缓冲的文本或 success 仍可能被转发为成功                            | 在读取每个后续 SDK 消息时先判取消，只发唯一取消终态          | `cancellation wins over buffered SDK text and success`                                                             |
| 已返回 result 后仍继续消费 SDK 流，可能拖住完成后的迭代                         | result 后立即结束消费，释放 query；不继续读取后续事件        | `stops consuming SDK events at the terminal result and releases the query`                                         |
| 消费者提前停止迭代，SDK 子进程没有明确中止                                      | finally 总是 abort；不把正常 EOF 误报为用户取消              | `aborts the SDK query when its consumer exits early`、`keeps an incomplete stream distinct from user cancellation` |
| 同 session 并发 resume 覆盖 activeRuns，取消可能命中错误请求                    | 重复活动 session 在调用 SDK 前拒绝；init 也检查归属冲突      | `does not allow a concurrent resume to steal cancellation ownership`                                               |
| result session 与 init 不一致却被当作成功；fresh run 的后续 init 可更换 session | 成功 result 必须匹配活动 session；后续 init 不得切换 session | `rejects a success result for another session`、`rejects a second init that changes the session of a fresh run`    |

测试文件：[`adapter.test.ts`](../../packages/adapter-claude-code/test/adapter.test.ts)。
另有 `rejects a fresh init collision without aborting the existing owner` 验证新 query 的 init 冲突
只关闭自己，不影响既有 query 的取消归属；同 session 两轮测试确认上一轮的 finally abort 不污染下一轮的新 controller。
这里的取消证据只证明已知 session 的 Adapter 语义；不证明真实 SDK 在任意网络故障下的停止时间，
也不提供 Gateway 默认应用尚未注册的 Claude 功能。

## 验收边界

- 自动化：Adapter 的文本、引用文本、部分流、final、resume、取消、异常脱敏和故障路径。
  本分支 `pnpm run ci` 通过：37 个测试文件、294 项测试；其中 Claude Adapter 19 项（新增 8 项），
  formatting、typecheck、public readiness 均通过。这是本地自动化结果，不是 GitHub Linux CI 或真实模型验收。
- 本机真实检查：官方 CLI signed-out 状态，而不是模型认证成功或消息投递成功。
- 仍未完成：自有凭据成功两轮、真实取消与重启恢复、WeCom 私聊/群聊、图片与工具交互。
- 不改 SDK 锁定版本、不改许可证、不提升 README 能力声明；完整条件仍见
  [Claude 评估](../claude-code-adapter-evaluation.md) 与[证据规范](../evidence-claims.md)。
