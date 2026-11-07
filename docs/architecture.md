# 架构与信任边界

Control Plane 包括 CLI、Hub、Scheduler、NotificationDispatcher 和 SQLite；执行 Worker 经 HTTP 获取任务并调用 Agent Adapter。Windows Startup Task 启动 Job Object 持有进程和 Runtime Launcher，后者监督 Hub 与 Worker，并在异常退出时关闭另一组件。

Job Object 用于进程树生命周期，不是 OS 安全隔离。当前仍为 trusted-local：Agent 与 Worker 使用同一操作系统用户，不声称阻止 Agent 自行访问其他文件。Hub 默认仅监听回环地址。详见 [windows-runtime.md](windows-runtime.md)、[security-model.md](security-model.md) 和 [scheduling.md](scheduling.md)。
