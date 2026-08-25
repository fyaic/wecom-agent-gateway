# ADR 0003：企业微信官方 SDK 优先

- 状态：已接受
- 日期：2026-08-20

## 决策

Bot WebSocket 直接依赖企业微信官方 `@wecom/aibot-node-sdk`。认证、心跳、重连、协议 frame、媒体加解密、被动回复和主动推送均不自行实现。

## 原因

官方 SDK 已覆盖这些协议能力，官方 OpenClaw 插件也用同一 SDK 完成生产级 Channel。自建协议栈只会增加兼容性、安全与维护风险。

## 影响

transport 对 SDK 做薄封装，通过注入 client 进行 contract test；升级 SDK 时检查 changelog 并完成自动与真实沙箱回归。ACL、路由、会话和 Agent 生命周期仍由本项目负责。
