# ADR 0024：长任务原生取消控制卡

状态：Accepted
日期：2026-08-26

## 背景

可变回复能说明任务仍在运行，但长任务缺少可靠的用户停止入口。把“停止”作为普通消息交给模型解释会
排在同会话运行之后，既不能及时中断，也可能被误解。ask-user、审批和最终回复动作都有不同的恢复语义，
不应被复用为运行控制。

## 决策

- 取消是 Gateway Core 控制面。仅当 Adapter 声明 `cancel`、实现 `cancel(sessionId)`，且 Transport 支持
  主动结构化交互时启用。
- 官方 SDK 规定同一 stream 的模板卡只能回复一次。已有可恢复 session 且 Transport 支持首帧组合交互
  时，第一帧直接附带 danger 样式“停止任务”，最终帧自然清除；首轮尚无 session 时不伪造取消能力。
  不支持组合流的 Transport 在默认 15 秒阈值后使用独立主动卡降级。可通过
  `GATEWAY_RUN_CONTROL_ENABLED`、`GATEWAY_RUN_CONTROL_AFTER_MS` 和
  `GATEWAY_RUN_CONTROL_TIMEOUT_MS` 调整。
- `run_control_*` 使用独立 SQLite 表和 namespace，持久绑定 account、conversation、原 sender、TTL 与
  首答状态。它不复用 approval、Runtime Interaction 或 reply-action 的语义。
- callback 先通过 ACL、入站去重与 SQLite 原子 resolve，并在企业微信五秒窗口内原位显示“正在停止”，
  随后直接调用绑定 session 的 Adapter cancel；不创建 Prompt 或第二 turn。
- 任务结束时 pending 控制记录变为 completed，进程内绑定立即移除。已完成卡第一次点击只原位说明
  “任务已经结束”，重复点击静默；错误发送者、过期及进程重启后的陈旧 callback 均不能取消后来复用
  同一 session 的任务。
- cancel 调用失败时不伪称已停止；Gateway 恢复运行状态并发送独立失败提示。秘密、session ID 和内部
  control ID 不进入普通日志或正文。

## 结果

- 不同 Kernel 共用相同长任务 UX，但取消语义仍由各 Adapter 的原生接口兑现。
- Bot 可变文字承载显式状态与内容进度；首帧停止卡或降级主动卡承载一次性用户决定。
- 当前功能是单进程 live-run 控制，不宣称重启后恢复取消能力；耐久记录只保证 ACL、幂等和陈旧卡安全。

## 验证

- Core tests 覆盖阈值展示、danger 样式、原 sender 限定、原 session cancel、最终停止文案、重复 callback
  静默，以及快速/不可取消运行不展示。
- SQLite tests 覆盖跨 sender 拒绝、原子首答、重复、正常完成和过期。
- 2026-08-28 真实企业微信私聊点击验收通过：停止卡可见，一次点击只结算一条 `resolved/cancel`，Pi
  原生 run 在 21.045 秒进入 `cancelled`；Outbox 零积压/死信且 Gateway 保持 ready。
- 同日验收发现，阈值后主动停止卡会在任务正常结束后遗留；尝试在 stream 中把 notice 切换成 action 又
  违反官方“一条消息只回复一次 template_card”的契约。最终改为已有 session 首帧直接携带停止 action，
  最终帧清除；独立主动卡只作为无组合流能力的降级。
