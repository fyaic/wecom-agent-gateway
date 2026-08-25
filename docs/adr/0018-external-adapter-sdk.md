# ADR 0018：以版本化 SDK 装载可信外部 Kernel Adapter

- 状态：Accepted
- 日期：2026-08-24

## 背景

Runtime Contract v1 已隔离 Gateway 与 Kernel，但此前可选 Adapter 仍硬编码在应用 Registry。新增一个
不使用 ACP 的 Agent Kernel 必须修改 Gateway 宿主源码、依赖和选择分支，这会把 Kernel 集成演变成
Gateway fork，无法形成独立通用 Channel。

## 决策

新增 `@fyaic/wecom-adapter-sdk` 和 `GATEWAY_ADAPTER=external`：

- 外部模块默认导出由 `defineRuntimeAdapter()` 定义的 factory，也可命名导出 `createAdapter`；
- factory 只接收 Runtime Contract 版本、Adapter 自有的有界 JSON、可选 `RuntimeTool` catalog 和受控
  diagnostic 回调，不接收企业微信 Transport、Bot Secret、会话白名单、SQLite 或 Outbox；
- 模块可以是明确配置的 npm package、绝对本地路径或相对基准目录路径，不接受远程 URL 或
  `data:` / `node:` specifier；
- Gateway 在企业微信入口启动前校验 factory 返回值、Contract v1、稳定 ID、`run()` / `health()` 和
  capability；存在 RuntimeTool 时 Adapter 必须明确声明 `tools`；
- SDK 提供公共类型、配置解析、装载器和模板；模板运行共享 `exerciseTextRuntimeContract()`；
- 内置 Codex、ACP/Kimi、OpenClaw、Pi Adapter 继续保留，外部模块无需修改 Registry。

## 信任边界

外部 Adapter 是显式安装、与 Gateway 同进程运行的可信代码。JavaScript 本身无法阻止它读取
`process.env` 或文件系统；SDK 的窄 factory context 是接口边界，不是进程沙箱。需要隔离不受信代码时
必须使用 ACP 等子进程协议和环境 allowlist，或未来的独立 Adapter Host，不能把未知 npm 包直接配置
为 external。

Adapter 只翻译 Kernel 的 SDK/RPC、session 和事件。它不实现企业微信认证、消息路由、ACL、持久投递，
也不让 Gateway 参与 Agent 的模型选择、推理或 Prompt。

## 后果

新 Kernel 可以作为独立包迭代和测试；Gateway 只依赖稳定 Runtime Contract。代价是装载变为异步，且
操作者必须审计外部模块。当前 Public Preview 包仍从 monorepo 使用，正式 npm 发布与签名/来源证明在
首个公开 release 阶段处理。
