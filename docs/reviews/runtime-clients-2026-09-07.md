# Runtime client 更新复核（2026-09-07）

范围：[依赖 PR #61](https://github.com/fyaic/wecom-agent-gateway/pull/61)。不升级宿主 Agent、
不连接企业微信 Bot、不更改生产配置。文中“SDK 安装/类型/fixture 通过”不等于真实 Kernel 或 IM 认证。

## 更新与协议核对

| 依赖                       | 从 → 到                        | 已检查范围                                                                                                                                |
| -------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `@openai/codex-sdk`        | `0.151.0` → `0.153.2`          | 发布包 `dist/index.js` 与 `dist/index.d.ts` 分别逐字相同；随包 CLI 是 `0.153.2`，并不等同于本机独立 CLI `0.145.0`                         |
| `@openclaw/gateway-client` | `2026.8.1-beta.3` → `2026.9.1` | 公开 GatewayClient 构造、hello/event/close 回调、request timeout 与 stopAndWait 仍匹配 Adapter；新 Node 最低版本为 `22.19.0`；协议仍为 v4 |

参考：[官方 Codex SDK](https://developers.openai.com/codex/sdk)、
[OpenClaw 2026.9.1 client manifest](https://github.com/openclaw/openclaw/blob/v2026.9.1/packages/gateway-client/package.json)。
官方 SDK 指南区分 exec 型 TypeScript SDK 与提供原生交互事件的 app-server；此次 SDK npm 更新
不会替换独立 app-server 可执行文件，也不自动认证 app-server 新版本。

Codex 发布 JS SHA256 为 `d62ed107033bdba802b283c77d875e4bec3deb2704a910bb7e3f95059473b16f`，
声明文件 SHA256 为 `954d28bec3db17316c2f6acbbd157210ded9f75143c50827215739110327c7ac`；
两个版本对应文件分别一致。OpenClaw 引入/更新的 Gateway protocol 与 `ipaddr.js` 由锁文件精确固定，
不复制其连接、鉴权或重连实现到 Core。

## 随更新修复的实际问题

1. 原仓库要求 Node 22.13+，doctor 甚至只检查 major >=22，与新客户端要求不符。
   首次同步至 22.19.0+ 后，主审发现 Vitest 5 不支持 Node 23/25；源码仓库 engines、双语
   README/入门文档和 doctor 最终采用 `^22.19.0 || ^24.0.0 || >=26.0.0`，共 14 项版本边界 fixture。
2. 真实 SDK 检查超时后，旧 SDK Adapter 没有停止路径，检查已报告失败但仍等待 SDK 子进程自然退出。
   将 Adapter stop 映射到官方 SDK 的每次运行 AbortSignal，不自行管理厂商进程协议；正常完成的
   controller 及时移除，支持多个活跃 run 一同退出。新增 fake SDK 测试覆盖并发停止与完成后清理。
   主审补充：消费者提前 return 也会 abort 自有 query；stop 后不投影已缓冲的文本/成功；
   `turn.completed` / `turn.failed` 后即结束消费，不等待无必要的后续 frame。再增加 4 项回归。

## 本地执行证据

- `pnpm install` 完成；首次 CLI 平台包下载重试后成功，锁定 CLI `--version` 为 `0.153.2`。
- 首次 `pnpm run ci`：37 个测试文件、343 项通过；主审追加清理回归后 347 项通过，
  Node 支持范围补充后 353 项通过；
  格式、类型和公开内容检查通过。
- `GATEWAY_ADAPTER=codex CODEX_ADAPTER=sdk pnpm agent:check`：启动新 SDK 的真实两轮检查，
  120 秒预算结束，返回 `agent-check-timeout`。不能判断为已登录成功、已完成对话、或厂商不兼容。
  独立 `codex login status` 仅说明本机现有 CLI 报告已登录，不替代这一新 SDK 成功证据。
- 修复 stop 后，使用同一 `checkAgent` 的 5 秒预算与真实 SDK、显式只读 sandbox 再查停止路径：
  返回超时代码并退出；它验证有界取消，不证明两轮对话成功。
- OpenClaw：本机 CLI 不在 PATH，默认本地端口没有监听。使用既有配置的公开 `agent:check` 返回
  脱敏的 `adapter-start-or-configuration-failed`，没有 Bot 连接或配置写入。新客户端的真实宿主通信未认证。

这些结果没有提升原生 video/quote、真实网络故障、Linux 24h 或其他 Adapter 的证据级别。
合并前仍需主审 Linux CI；新版本完整真实会话需在对应宿主可用时独立补录，不以本次 CI 代替。
