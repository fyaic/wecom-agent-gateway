# 授权维护实机推进 · 2026-10-08

这是同日首轮插件交付后的追加验证，不改写[首轮记录](auth-maintenance-2026-10-08.md)。

## 实际经过与结果

| 环节            | 证据与结果                                                                                                       | 不能证明                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 原 Bot 页面定位 | 私聊 → 资料 → 去管理 → 目标详情 → 可使用权限；页面双标识与 Gateway 配置精确匹配                                  | 管理后台导航已产品化               |
| 私有配置生成    | 用真实 `auth:setup` 生成单一消息能力配置；0700 目录、0600 文件，在仓库外                                         | 所有能力已授权                     |
| 隔离 CLI 身份   | 默认及旧指定 profile 均不匹配；在全新目录用官方 manual 流程接入已有 Bot，后续身份精确匹配                        | 自动初始化是已发布产品能力         |
| 页面只读检查    | 真实 Wrapper inspect 返回 page-verified，消息权限有效期至 10 月 15 日 16:44（当地时间）                          | 本 Agent 完成了续期                |
| 维护单周期      | 真实 engine + provider 返回 healthy、attempts=0、businessVerified=false                                          | 已发生恢复/撤权/预续               |
| 业务 API 复探   | `auth:probe` 返回 identity=matched、message-sessions 验证通过、3 条会话                                          | 文档、通讯录、邮件、待办健康       |
| 真实消息发送    | 同 Bot CLI 向授权私聊和测试群各发送一条验收消息，API 接受，原生客户端均可见                                      | SDK 入站或 Agent 推理重新验收      |
| 可见链接入口    | 在目标私聊放置官方授权页链接；权限页已关闭，Keeper inspect 非 existing-window 模式自行点击链接、打开并校验正确页 | 从任意桌面/工作台自动选择 Bot 会话 |

观察期间页面从“未授权”变为已授权，另有邮件权限显示有效；本 Agent 仅发起过确认询问，
没有执行任何授权点击或 Keeper renew/pre-renew。因此不能把外部状态变化归因为本程序的自动续期。
本轮能力白名单始终仅消息，不验证或维护额外邮件权限。

初始化复用了已有凭据，通过官方交互密码输入完成；凭据没有进入 argv、源码或报告。
这是维护者一次性本地验收操作，不是社区发布的自动初始化接口。原 profile 未重新 init，Gateway `.env` 未改。

## 子 Agent 与主审

- 导航子 Agent：复核 Keeper 和官方源码，确认不存在已验证可直达该授权页的官方操作系统深链；没有猜测 URI Scheme 或实现截图坐标导航。
- CLI 子 Agent：实现受控子环境、严格同身份只读探针及 49 项 fake 测试。
- 主 Agent：实机导航与隔离配置、业务复验、两处客户端送达核验、可见链接重开页面、CLI 入口和集成审查。
- 首次真实探针在身份已匹配后拒绝会话响应。原因是响应比文档示例多了 `extra_identity_context`；
  修正为再次验证这一身份，而不是忽略字段或放宽到任意响应，新增不同身份/缺字段等回归后实测通过。

最终完整 CI：**50 个测试文件 / 636 项通过**，格式、类型与公开准备检查通过。
新增 49 项探针测试和 3 项命令入口测试，真实 API 与客户端结果按上表独立记录，不用单测替代。

## 产品边界

`auth:probe` 只执行只读链路，结果按 `capability:message-sessions` 限定。
它不初始化、不发送消息、不修改权限、不重放失败写操作，也不把探针成功混入 SDK 健康指标。
身份文本解析是对当前 CLI 输出的严格兼容合同；格式变化会报错，需要更新已验证 fixture，而不是模糊匹配。

当前可见链接打开页面的能力来自现有 Keeper，本轮没有复制 GUI 自动化到 Gateway Core。
工作台管理页不暴露所需 AX DOM，而权限弹窗和聊天链接可读；因此完整桌面入口仍是明确缺口。

## 尚未闭环与后续顺序

1. 从普通聊天/非目标会话恢复到唯一目标 Bot 的稳定入口；目前只证明目标链接已经可见的条件路径。
2. 在用户已授权的同一能力范围内完成真实到期恢复及临期预续，核对有效期推进和不重复撤权；不能用本次自然状态变化代替。
3. 对每个用户实际启用的办公能力提供单独、安全的探针。文档写入必须使用专用测试对象，不用消息查询替代。
4. 上述真实条件满足后再启用参考部署的常驻维护；当前默认开关仍关闭，没有启动 watch、安装服务或改变生产 Gateway。

## 官方依据

- [CLI 1.1.0 配置目录解析](https://github.com/WecomTeam/wecom-cli/blob/cd0480e0e4013c99cc9e7bb4a3247ec949a052d8/crates/wecom-cli/src/config.rs)：独立 CONFIG_DIR。
- [官方 manual 初始化实现](https://github.com/WecomTeam/wecom-cli/blob/cd0480e0e4013c99cc9e7bb4a3247ec949a052d8/crates/wecom-cli/src/cmd/auth.rs)：已有 Bot 凭据流程；不以扫码创建作为续期方案。
- [新版授权解析](https://github.com/WecomTeam/wecom-cli/blob/c4b9b6610c7ca2854441bfa336a5b458daeeb707/crates/wecom-cli/src/auth/resolve.rs)：外部 access token 覆盖风险，故子环境不盲目继承。
- [官方浏览器调用](https://github.com/WecomTeam/wecom-cli/blob/c4b9b6610c7ca2854441bfa336a5b458daeeb707/crates/wecom-cli/src/browser.rs)：打开系统默认浏览器，不是本项目需要的 WeCom 权限页深链证明。
