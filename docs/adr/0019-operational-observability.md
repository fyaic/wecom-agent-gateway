# ADR 0019：本机健康检查与无用户数据指标

- 状态：Accepted
- 日期：2026-08-24

## 背景

受管重启已经验证，但 systemd、容器健康检查和告警不能依赖搜索普通日志，也不能为了可观测性暴露
用户、群、会话、消息正文、Prompt、模型输出、内部 ID 或凭据。

## 决策

Gateway Core 提供 `operationalSnapshot()`，只返回运行状态、Transport/Adapter/Store 布尔健康、当前
工作聚合数和 Outbox 各状态数量。可选 `@fyaic/wecom-observability-local` 在 `127.0.0.1` 或 `::1`
提供：

- `GET /livez`：本进程是否仍处于可服务生命周期；
- `GET /readyz`：Gateway、Transport、全部 Adapter 和 Store 是否共同 ready；
- `GET /metrics`：Prometheus text format 的 gauges、枚举型事件 counters 和时延 sum/count。

指标 label 只来自代码定义的 phase、conversation type、command type、effect、component 和 operation；
不使用 Adapter ID、tool name、错误正文或任何消息/会话字段。健康采样有超时，失败只返回通用 503。
服务强制 loopback，不能通过配置绑定 `0.0.0.0`。需要远端采集时使用同主机 collector、受限代理或
显式的基础设施策略，而不是放宽 Gateway 默认边界。

现有 typed lifecycle callbacks 和结构化 JSON 日志承担无标识 tracing：记录 Channel 回执、Kernel
首事件/首文本、完成、投递、审批、背压和基础设施阶段及耗时，但不生成用户/session/message trace
ID。需要跨进程关联时由部署侧在不引入用户标识的前提下聚合阶段指标，Gateway 不持久化 transcript。

## 非目标

- 不把指标用于解释 Agent 思考、评价回答质量或记录 transcript；
- 不在本阶段提供公网管理 API、远程控制面或用户级 analytics；
- 不声称指标内存 counters 跨进程持久化；累计值在重启后从零开始。
