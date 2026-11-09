# Windows Runtime

TaskCircuit 使用当前登录用户的 Windows Startup Task，不安装 Windows Service，也不要求默认提升管理员权限。任务在用户登录时启动一个 Windows Job Object 持有进程；它把 Runtime Launcher 放进带 `KILL_ON_JOB_CLOSE` 的 Job 后才允许启动 Hub 和 Worker。Worker 的 Agent 子进程继承包含关系。Job Object 只管理生命周期，并非文件系统或网络安全隔离。

后台启动使用无控制台的 Windows 程序启动 PowerShell，并等待其退出；安装时由 Windows PowerShell 5.1 和系统 .NET Framework 编译该程序，保存于 TaskCircuit Home。启动器不改变 Job Object 的进程管理。已有安装升级后需要再次执行 `taskcircuit runtime install` 更新计划任务。

命令：`taskcircuit runtime install`、`start`、`stop`、`restart`、`status`、`uninstall` 和 `run`。install 注册或更新当前用户登录触发任务，使用 Interactive 和 Limited，不启动 Agent；start 不会隐式安装；uninstall 先停止运行时、删除启动任务并保留数据库和工作数据。已存在但不属于 TaskCircuit 的同名任务不会被覆盖或删除。

默认 Home 使用 `TaskCircuit` 任务名；自定义 Home 使用路径的短哈希作为后缀。动作使用安装时解析出的绝对 Node、脚本和应用路径，不依赖 shell profile。测试只使用随机 `TaskCircuit-Test-...` 任务并清理。程序文件和用户状态分开；Home 可由 `TASKCIRCUIT_HOME` 指定。

Launcher 通过当前 Home 的命名管道和随机实例身份防止重复启动并验证 stop/status 请求；PID 和 `runtime/runtime.json` 只是提示，陈旧文件不会被当作运行中的实例。默认监听 `127.0.0.1:4317`，端口被占用时失败，不结束占用者。`TASKCIRCUIT_PORT` 可用于隔离测试。

正常停止先让 Worker 停止领取并等待当前工作，再关闭 Hub、Scheduler、Dispatcher、SSE 和 SQLite；限时未完成时关闭 Job Object 清理进程树。Hub 或 Worker 异常退出会停止另一组件并返回非零码；不会无限重启。强制停止后未完成的工作仍依赖 Execution 租约到期恢复。

`logs/runtime.log` 保存有限的结构化运行记录，达到 10 MB 后轮转，保留最多 5 个旧文件；不记录完整环境、Agent 提示词或外部会话 ID。本地通知也记录通用投递信息。`taskcircuit doctor` 检查 Node、Home、SQLite、Hub、Worker、启动任务和可用 Agent CLI；Codex Windows sandbox 未主动验证。

测试验证任务定义及手动启动，不执行 Windows reboot、logoff 或用户切换，因此真实重启与登录后的自动启动尚未验证。

## v0.1.2 执行与取消

用户取消、Worker 停止或租约失权时，Worker 会请求停止当前受管理的 Agent 进程；无法确认的执行结果标记为 `execution_outcome_unknown`，不会因超时或租约过期而自动重做。终止进程无法撤销已经发送的外部请求。Windows Job Object 和进程树清理属于进程生命周期管理，不提供文件、网络或凭据隔离，也不是操作系统安全沙箱。真实 Agent 取消测试确认了直接进程退出，但没有独立验证所有脱离的后代进程。

Windows 是主要验证平台；实际 reboot 或 logoff/login 周期未测试。Linux 进程组清理未验证。
