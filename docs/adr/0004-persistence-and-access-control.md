# ADR 0004：SQLite 持久化与 fail-closed allowlist

- 状态：已接受
- 日期：2026-08-20

## 决策

单实例 MVP 使用 Node 内置 SQLite 保存已授权的入站原始事件、幂等键、runtime session 映射、
耐久投递 outbox 和投递结果。真实入口必须配置 sender 或 conversation allowlist；两者均为空时
拒绝启动，未授权消息既不持久化也不进入 runtime。
Store 每次打开文件数据库后强制设置 `0600`；父目录仍由应用入口以 `0700` 创建。

## 原因

进程内 Map 无法跨重启防重复或恢复 Codex thread。企业微信 Bot 一旦接入真实组织，也不能默认把所有可见会话暴露给 Agent。

## 影响

SQLite 已具备文本和 artifact 化媒体命令的发送前持久化、事务认领、租约过期接管、重试和死信，
并对文本支持流式旧版本替代。
它提供 at-least-once，不声称 exactly-once；媒体 spool 已按 ADR 0009 完成，多实例全局顺序、
背压和运维管理尚未完成。多实例前应评估将 store 接口迁移到支持并发事务租约的服务型数据库。
