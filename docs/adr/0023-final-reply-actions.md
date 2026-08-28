# ADR 0023：最终回复快捷操作与 callback continuation

状态：Accepted  
日期：2026-08-25

## 背景

ask-user 交互解决了 Agent 在运行中主动向用户提问，但最终回答后的“继续展开”“换个角度”等下一步仍
需要用户重新输入。企业微信官方 SDK 提供 `replyStreamWithCard`，可以让最终流式回复和一张模板卡片
处在同一条消息中；卡片回调还可以在五秒内原位收敛。

快捷操作不能复用审批语义，也不能由 Gateway 根据按钮文案猜测意图。已经结束的 Agent run 也不能走
`interaction-live-resume` 快车道，否则会绕过正常会话队列和并发控制。

## 决策

- Runtime Contract 的最终 `message-completed` 可携带中立 `actions`；部署也可通过
  `GATEWAY_REPLY_ACTIONS_JSON` 配置一组安全的通用动作。两者都只有 `value`、`label` 和显式 style，
  不接受企业微信卡片 JSON。
- 操作员默认动作只附加于普通入站消息产生的首轮终态，点击该动作后的 callback continuation 不自动
  继承默认动作，避免一次点击再次生成相同卡片形成无界循环。多步流程只有在 Adapter 本轮显式返回
  `message-completed.actions` 时才进入下一步；是否继续由 Kernel Adapter 明确决定，而非 Gateway 猜测。
- Gateway 为最终动作生成 task ID，使用现有 SQLite Runtime Interaction 保存 account、conversation、
  sender、Adapter、session、TTL 和动作集合。新快捷卡会取消同会话旧快捷卡；真正的 ask-user 请求也
  可替换旧快捷卡，但不能被快捷卡覆盖。
- 企业微信组合流在不同发送时机都存在真实客户端静默丢弃卡片的情况。最终动作来自
  `message-completed`，因此 Gateway 保持原可变流式文字，终态完成后立即通过 durable proactive path
  发送独立模板卡片。Transport 仍保留 `replyStreamWithCard` 映射，供未来经过客户端认证的场景使用；
  不得以服务端成功回执冒充客户端可见。
- 用户点击后，Gateway 先完成 ACL、入站去重、原子 resolve 和五秒内原位更新，再创建 durable resume。
  `resumeMode=new-turn` 明确表示这是一个真实 callback continuation：必须进入正常会话串行队列和 run
  semaphore，不得借 `interaction-live-resume` 绕过背压。
- 被选中的 action value 由原 Adapter 或操作员预先绑定，并作为该真实 callback 的规范化输入恢复同一
  session。Gateway 不从 label 推断内容，不执行命令，也不授予副作用；若后续触发写工具，仍必须经过
  独立审批控制面。
- 快捷动作过期时只静默失效，不恢复 Agent。已完成、过期或被替换的 Runtime card callback 不再次发出
  完成态更新，避免真实客户端生成重复结果卡，也不产生第二次 continuation。

## 结果

- 最终回答后紧邻一张原生快捷操作卡，点击后可继续相同 Agent session。
- ask-user、reply action、workflow 和 approval 仍是不同语义；按钮颜色不代表授权。
- SQLite/Outbox 保留进程恢复、重试和幂等边界；新动作替换旧动作，避免旧卡长期阻塞新的 elicitation。
- 操作员默认卡是一次性快捷入口，不是自动重复菜单；一次点击最多产生一次 continuation。
- Pi、Codex SDK / App Server、OpenClaw 和支持 session load 的 ACP Adapter 均支持已结束 session 的
  reply-action continuation；外部 Adapter 必须同时声明 `interaction-resume`、`reply-actions` 并实现
  `resumeInteraction()` 才能启用。

## 验证

- Transport tests 覆盖组合回复、官方模板映射和 `846608` 主动降级。
- Core/SQLite tests 覆盖最终动作、同 sender/session continuation、重复点击、旧卡替换、静默过期和
  new-turn 并发队列。
- 公共 reply-action testkit 覆盖同 session 新 turn 与进程内重复投递幂等；Pi、Codex、OpenClaw、ACP
  和外部模板均运行该契约。
- 真实企业微信私聊已验证最终文字后只出现一张主动快捷卡；点击后同 session continuation 成功，且
  没有再次继承默认动作形成循环。Outbox 最终零 pending、零 leased、零 dead。
