# ADR 0022：原生 ask-user 与 live interaction resume

状态：Accepted  
日期：2026-08-25

## 背景

ADR 0021 选择 durable deferred resume 作为通用可靠性基线。但 Pi RPC 的
`select/confirm/input/editor` 并不会挂起并结束 Agent run：它发送 `extension_ui_request` 后让原 tool
call 持续等待，直到宿主返回同 ID 的 `extension_ui_response`。如果 resume 仍进入 Gateway 正常会话
队列和 run semaphore，原 run 占用的槽位会阻止自己的控制响应，形成死锁。

Codex App Server 同样提供实验性 `item/tool/requestUserInput` 服务端请求：原 turn 等待客户端按原
JSON-RPC request ID 返回问题答案，不能把答案伪装成新 turn。一个请求可以包含 1–3 个问题，且可能
同时包含选项和自由输入。

企业微信模板卡片没有开放文本控件，因此 input/editor 还需要不依赖模型解析的 Channel-neutral 降级。

## 决策

Runtime Contract 增加三项向后兼容能力：

- Agent 可发出 `interaction-requested` 事件；
- `text-input` 请求由同 account、conversation、sender 的下一条纯文本完成；
- Adapter 可声明 `interaction-live-resume`，表示结果是仍存活调用的控制响应。

Gateway 仍先持久化 interaction，并在 callback 或文本提交时原子 resolve 和写入 durable resume entry。
对普通 `interaction-resume` Adapter，worker 按既有队列、租约和会话串行恢复。对额外声明
`interaction-live-resume` 的 Adapter，dispatcher 绕过语义 turn 队列，将结果直达当前持有 session 的
live worker；Adapter 必须按稳定 idempotency key 去重并验证原 request 仍 pending。

live resume 可以显式返回下一条 `interaction-requested`，用于把一个 Kernel 请求拆成多个 Channel
可表达步骤。Gateway 只允许仍在等待的 live interaction 这样续接；最终回答快捷动作等 new-turn
continuation 禁止借此打开嵌套交互。每一步仍单独持久化、绑定发送者并原子 resolve。

Pi Adapter 将 select/confirm 映射为企业微信结构化交互，将 input/editor 映射为 `text-input`，并以 Pi
原生 response 恢复原 tool call。不会把选择结果伪装成新的用户 Prompt。带 Pi 自身 timeout 的 dialog
先 fail closed，避免 Kernel timeout 与 Gateway TTL 竞争。

Codex App Server Adapter 将单题选项映射为单选，多题且满足企业微信长度边界时映射为多字段表单；
含自由输入或超出表单可读边界的问题按原顺序拆成单选/限定文本步骤。最终按原 question ID 和原选项
label 返回 `answers`。`isSecret=true` 不进入企业微信，直接 fail closed；Gateway 不把 IM 当密码输入框。

每个 account + conversation 同时只允许一个 pending interaction；text-input 额外绑定原 sender。第二个
请求、非纯文本、空文本、其他发送者、过期和无法找到 live worker 的结果均 fail closed。

## 结果

- Pi 原 run 可以在 `maxConcurrentAgentRuns=1` 时等待并恢复，不产生自锁。
- 选择和开放文本都保留结构化结果，不经模型重新解释。
- durable entry 继续记录 callback 决定和 at-least-once 投递，但进程重启后无法复活已经消失的 Pi
  原调用；这种场景进入重试/死信，而不是 synthetic Prompt 恢复。
- live resume 是可选 Adapter 优化，不改变其他 Kernel 的默认 deferred 语义。
- Pi 与 Codex App Server 共用同一 Runtime 交互语义，但各自只在上游真实阻塞请求存在时启用；Codex
  SDK 对照实现、OpenClaw 和 ACP 不因名称相似而虚报 ask-user。

## 验证

- deterministic tests 覆盖 Pi confirm/select/input 映射、重复 resume、worker 路由、单并发无死锁和
  scoped next-text 消费；SQLite 覆盖每会话单 pending 与 sender 范围。
- Codex tests 覆盖原生 server request/response ID、单选、多题顺序续接、原 label 还原、秘密输入拒绝
  和同一 live turn 无死锁；协议字段与本机 CLI 生成的 experimental TypeScript schema 对照。
- 本机 Pi `0.84.2` 加载仓库无副作用 extension 后，真实产生 `extension_ui_request`、接受原生选择值并
  继续原 run。企业微信私聊单选已完成原 run 恢复、原位结果更新和重复回调幂等验收；限定文本输入也
  已确认 scoped next-text 消费、1ms live resume 且不创建第二 turn。授权测试群 select 进一步通过
  group-only ACL、1ms live resume、原位更新和最终回复；跨发送者拒绝保留 deterministic 证据边界。
