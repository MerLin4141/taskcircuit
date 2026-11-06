# 架构与信任边界

Control Plane 包括 CLI、Hub、Scheduler、NotificationDispatcher 和 SQLite：Hub 在事务内记录领域状态、Runtime Change、通知与投递。Scheduler 处理持久计划；独立 Dispatcher 投递通知；SSE 客户端从 SQLite 顺序读取持久变化。Worker 仅经 HTTP 获取工作并提交结果。

Execution Plane 包括 Worker、Agent Adapter、mock/Codex/Claude 和独立 workspace。当前是 trusted-local 逻辑边界，不声称同 OS 用户的 Agent 无法自行访问其他文件。未来 sandboxed 才要求 OS 或运行时强制隔离。Hub 默认仅监听回环地址，尚无身份认证。

详见 [security-model.md](security-model.md)、[scheduling.md](scheduling.md)、[realtime.md](realtime.md) 和 [notifications.md](notifications.md)。
