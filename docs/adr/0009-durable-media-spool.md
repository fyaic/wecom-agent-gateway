# ADR 0009：出站媒体采用 Gateway 自管耐久 Spool

- 状态：已接受
- 日期：2026-08-21

## 决策

Agent adapter 发出 `media-output` 后，Gateway 不直接发送，也不持久化其原始路径。媒体必须先由
`MediaSpool` 从显式允许的源目录复制到 Gateway 私有根目录，生成随机 artifact ID、实际字节数和
SHA-256；随后只有这些元数据随 `proactive-media` 写入统一 outbox。

发送 worker 根据 artifact ID 解析 spool 文件，校验大小和哈希，再交给 transport。WeCom transport
在读取后再次校验，以缩小校验与上传之间的替换窗口；然后使用官方 SDK `uploadMedia` 和
`sendMediaMessage`。成功或死信后删除 artifact，重试期间保留。

## 安全和生命周期

- spool 根目录 `0700`、artifact 目录 `0700`、数据文件 `0600`；根目录拒绝符号链接；
- 源文件必须通过 `realpath` 位于 `WECOM_MEDIA_OUTPUT_ROOTS`，并以 `O_NOFOLLOW` 打开；
- 单 artifact 默认最大 50MB，总配额默认 500MB；读取后再次检查实际字节数；
- 数据库和普通日志不保存 Agent 原始路径或 spool 绝对路径；
- 启动时 SQLite 提供 pending/leased artifact 集合；spool 只清理项目命名的 staging 和无引用 artifact，不碰未知文件；
- stage 完成后原文件可以删除或修改，不影响待发 artifact；artifact 被修改时发送失败并进入重试/死信。

## 崩溃窗口

- 复制中崩溃：遗留 `.staging-*`，下次启动清理；
- stage 后、outbox 提交前崩溃：形成无引用 artifact，下次启动清理；
- outbox 提交后崩溃：artifact 被活跃引用保留，租约 worker 恢复发送；
- 远端接受后、本地完成前崩溃：可能重发，因此仍是 at-least-once；
- 完成本地事务后、删除失败：outbox 已终态，下次启动把 artifact 作为无引用对象清理。

死信 artifact 当前自动删除，因此尚不支持原媒体人工重放。生产恶意内容扫描、加密静态存储、
死信隔离区、多实例共享对象存储和配额告警属于后续增强。
