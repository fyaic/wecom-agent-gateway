# ADR 0012：持久化 Channel 审批控制面

- 状态：已接受
- 日期：2026-08-21

## 决策

Gateway 为所有 Kernel adapter 提供统一的 `requestApproval` 回调。只有注册为
`write/destructive + approval=required` 的工具可以请求审批；只读工具不进入审批链路。Gateway
不从自然语言推断批准意图，只识别两条精确控制命令：

```text
/approve ABCD1234
/deny ABCD1234
```

审批请求先写入 SQLite，再通过独立、不可被 Agent 流式状态覆盖的 Bot 主动消息显示动作类别、
八位公开审批码和失效时间；原可变回复只提示“等待审批”。
控制命令必须来自原请求相同的 Bot account、conversation 和 sender，并经过既有 fail-closed ACL。
它绕过该会话的 Agent 队列直接进入控制面，否则原 Agent turn 在等待审批时会阻塞同会话命令。
同一 Agent run 的多个并发工具请求按顺序逐个展示和决定，避免一条可变消息覆盖尚未处理的审批码。

批准、拒绝、过期和中断都通过单条条件更新从 `pending` 转换，重复命令不会再次产生副作用。
Gateway 策略默认上限五分钟，但 Kernel adapter 可以声明更短的协议截止时间，实际采用二者较短值；
Codex App Server 当前默认 90 秒。正常停机、重启或 Kernel turn 先结束时，未完成审批标记为
`interrupted`，绝不在恢复后补执行旧副作用。

## 边界

- Gateway 只管理等待、身份绑定、持久状态和决定传递，不解释工具参数、用户目标或 Agent 思考。
- 展示摘要由受信任的工具注册函数生成，可以包含标题、截止时间等经校验的必要业务字段；不显示
  原始 JSON、内部 ID、凭据或工具结果。该摘要与审批状态一起持久化审计。
- 审批码是会话内控制令牌，不替代 ACL；群聊中也只有发起原请求的成员可以决定。
- 存储故障时 fail closed：工具不执行；超时处理失败会把内存等待转成 `interrupted`，避免 Agent run
  永久悬挂。
- 审批生命周期日志只包含阶段、会话类型、稳定工具名、副作用等级和耗时。
- Kernel adapter 必须在收到 `approved` 后才调用工具执行函数。`denied`、`expired`、`interrupted`
  都返回未执行结果。
- Kernel turn 结束会撤销该 run 的所有未决审批，防止 App Server 已放弃工具调用后仍留下可批准的
  孤立记录。
- Transport 必须声明 `proactive-message` 才能承载审批；不能保证独立提示可见时 fail closed，禁止
  把审批码退回会被 Agent 增量覆盖的可变回复。

## 影响

通用状态机和 Codex adapter 映射已经可以承载写工具。首个实现 `wecom_todo_create` 采用精确命令
映射、参数二次校验和返回 ID 移除，并由 `WECOM_CLI_WRITE_TOOLS_ENABLED` 独立默认关闭。2026-08-24
已完成真实企业微信私聊的独立提示、批准、单次执行和测试待办清理；超时也由此前未批准请求确认
不会启动工具。完成拒绝与进程重启中断的真实验收后，才能评估默认启用。

进程崩溃无法恢复原 Kernel 调用栈，所以持久化的价值是保留审计状态并保证旧操作不被静默执行，
不是跨进程继续执行。未来若要恢复等待，必须引入可持久工作流引擎并重新评估 exactly-once 语义。
