# 安全模型

## Trusted Local

V0.1 的 Codex、Claude Code 和 mock 使用 `trusted-local`：CLI Agent 由用户安装、登录并授权，与 Worker 使用同一操作系统用户身份。Hub 独占 SQLite 业务访问；Worker 经 HTTP 获取当前执行所需数据，Adapter 不接收数据库连接、数据库路径、TaskCircuit Home、内部密钥或无关工作状态。子进程过滤所有 `TASKCIRCUIT_` 环境变量。当前没有 Hub 认证令牌、owner key、数据库凭据或内部 IPC secret。

这是逻辑边界，不提供操作系统级文件保密保证。用户本人授权运行的 Agent 仍可能凭同一 OS 用户权限主动遍历用户文件系统并找到数据库。Codex 自带的沙箱和 Claude 的工具权限属于各自产品能力，不能推导出所有 TaskCircuit Agent 都有统一的 OS 隔离。

正常输入保护的是意外耦合、数据库 API 依赖、内部环境变量和路径披露，以及不必要运行时状态的传递。用户明确放入事件或指令的内容属于任务数据，TaskCircuit 不把这些内容误判为内部路径并删除。

## Sandboxed（未来契约，尚未实现）

`sandboxed` 将要求独立执行环境；只暴露 workspace 和显式授权的输入，不挂载 Control Plane；工作区采用允许列表，凭据最小授权，并对挂载和网络策略作明确配置。实现方式可在未来评估容器、虚拟机、操作系统沙箱、专用身份或远程执行器。本版拒绝配置 `sandboxed`，不会默默降级为 trusted-local。

Scheduler 仅将计划配置的事件 payload 交给 Event Router；内部计划、数据库路径和状态根不进入 Agent context。Retry 次数只传给 Adapter，不放入 Agent 提示词。

Runtime Change 仅保存最少状态，不包含完整提示词、环境、外部 session ID 或内部路径；通知只使用任务标题和通用通知文字。SSE、Inbox 和通知接口沿用仅回环监听的 trusted-local 边界，不提供公网认证。

Windows Job Object 是进程生命周期包含机制，不提供文件系统、凭据或网络隔离；Runtime 仍使用 trusted-local。启动任务使用当前交互式用户、Limited 权限。stop 通过实例身份和本机命名管道定位运行时，不按进程名称批量终止。
