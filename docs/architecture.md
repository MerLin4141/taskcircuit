# 架构与信任边界

Control Plane 包括 CLI、Hub、Scheduler 和 SQLite：Hub 在事务内记录事件、工作、执行、会话、交互和计划。Scheduler 轮询持久计划，事务化完成触发和路由；Worker 仅经 HTTP 领取执行并提交结果。

Execution Plane 包括 Worker、Agent Adapter、mock/Codex/Claude 和独立 workspace。当前是 trusted-local 逻辑边界，不声称同 OS 用户的 Agent 无法自行访问其他文件。未来 sandboxed 才要求 OS 或运行时强制隔离。

Hub 默认仅监听回环地址，尚无身份认证。详见 [security-model.md](security-model.md) 和 [scheduling.md](scheduling.md)。
