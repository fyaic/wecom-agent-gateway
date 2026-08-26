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
- Gateway 为最终动作生成 task ID，使用现有 SQLite Runtime Interaction 保存 account、conversation、
  sender、Adapter、session、TTL 和动作集合。新快捷卡会取消同会话旧快捷卡；真正的 ask-user 请求也
  可替换旧快捷卡，但不能被快捷卡覆盖。
- WeCom Transport 声明 `reply-with-presentation` 后，在最终更新调用官方
  `replyStreamWithCard`。企业微信组合流从首帧起必须保持 `stream_with_template_card` 消息类型，即使
  模板卡片只在最终帧出现；不能先用普通 `stream` 再在终态切换类型。不支持组合回复的 Transport 先完成文本再主动发送卡片；企业微信回复窗口返回
  `846608` 时也降级为主动 Markdown 加主动模板卡片。
- 用户点击后，Gateway 先完成 ACL、入站去重、原子 resolve 和五秒内原位更新，再创建 durable resume。
  `resumeMode=new-turn` 明确表示这是一个真实 callback continuation：必须进入正常会话串行队列和 run
  semaphore，不得借 `interaction-live-resume` 绕过背压。
- 被选中的 action value 由原 Adapter 或操作员预先绑定，并作为该真实 callback 的规范化输入恢复同一
  session。Gateway 不从 label 推断内容，不执行命令，也不授予副作用；若后续触发写工具，仍必须经过
  独立审批控制面。
- 快捷动作过期时只静默失效，不恢复 Agent。已完成、过期或被替换的 Runtime card callback 不再次发出
  完成态更新，避免真实客户端生成重复结果卡，也不产生第二次 continuation。

## 结果

- 最终回答和下一步动作形成一个紧凑的原生消息，点击后可继续相同 Agent session。
- ask-user、reply action、workflow 和 approval 仍是不同语义；按钮颜色不代表授权。
- SQLite/Outbox 保留进程恢复、重试和幂等边界；新动作替换旧动作，避免旧卡长期阻塞新的 elicitation。
- Pi、Codex SDK / App Server、OpenClaw 和支持 session load 的 ACP Adapter 均支持已结束 session 的
  reply-action continuation；外部 Adapter 必须同时声明 `interaction-resume`、`reply-actions` 并实现
  `resumeInteraction()` 才能启用。

## 验证

- Transport tests 覆盖组合回复、官方模板映射和 `846608` 主动降级。
- Core/SQLite tests 覆盖最终动作、同 sender/session continuation、重复点击、旧卡替换、静默过期和
  new-turn 并发队列。
- 公共 reply-action testkit 覆盖同 session 新 turn 与进程内重复投递幂等；Pi、Codex、OpenClaw、ACP
  和外部模板均运行该契约。
- 真实企业微信客户端验收在 M2.3 合并部署后执行，未提前标记通过。
