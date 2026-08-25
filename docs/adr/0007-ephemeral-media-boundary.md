# ADR 0007：入站媒体采用短生命周期物化边界

- 状态：已接受
- 日期：2026-08-20

## 决策

企业微信协议媒体只能由 transport 使用官方 SDK 下载和解密。Channel 将解密后的媒体写入单次
消息专属临时目录，再以 runtime-neutral 本地路径交给 Kernel adapter；无论 run 成功、失败或
取消，Gateway 都在 `finally` 阶段调用幂等 release 删除整个目录。

默认约束：

- 临时目录权限 `0700`，文件权限 `0600`；
- 单文件和整条消息累计大小均不得超过 50MB，可由部署配置下调；
- 文件名只使用 basename、控制长度并添加消息内序号，不接受原始目录；
- MIME 优先由文件签名识别，再使用安全扩展名映射；
- URL、AES key 和临时路径不写入 SQLite 或普通日志；
- 启动时只清理指定临时根目录下、具有项目固定前缀且超过保留期的孤儿目录。

## 边界

Transport 负责企业微信协议、下载、解密和临时文件安全；Gateway 负责物化与 run 生命周期；
adapter 只把本地媒体映射到 Kernel 原生输入。任何一层都不能把图片自动改写为文字描述，或
注入附件占位 Prompt。缺少对应原生能力的 Kernel 必须通过 capability 明确拒绝或由上层显式
配置降级，不能伪装为已经消费媒体。

Agent 输出媒体采用独立的显式事件。Transport 只读取 `realpath` 位于部署配置允许根目录内的
普通文件；空根目录时 fail closed。Gateway 检查 Kernel/Transport capability 交集和每 run 数量
上限，随后调用官方 `uploadMedia` 与 `sendMediaMessage`。本地路径不写入投递日志。

出站媒体已按 ADR 0009 复制到 Gateway 控制的耐久 spool，再以 artifact 引用进入统一 outbox；
Agent 工作区路径仍不持久化。该扩展提供进程崩溃恢复和 at-least-once，不声称 exactly-once；
恶意内容扫描仍是部署策略待办。
