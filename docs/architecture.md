# 架构与信任边界

Control Plane：CLI / 未来 Desktop 通过 Hub 操作 Work Item、Execution、Agent Session 和 Interaction；Hub 是唯一的 SQLite 业务访问者。

Execution Plane：Worker 通过 HTTP 获得当前 Execution 的最小输入，经 AgentAdapter 调用 mock、Codex 或 Claude Code；Agent 在独立 workspace 工作。Worker 和 Adapter 不连接 SQLite。

两侧目前的 trust boundary 是逻辑边界：进程同属一个 OS 用户，不声称防止其自行访问其他文件。未来 `sandboxed` 模式才要求 OS 或运行时强制隔离 Control Plane，并仅允许显式挂载的输入。详细约束见 [security-model.md](security-model.md)。

Hub 仅监听回环地址，尚无身份认证；租约令牌拒绝过期领取的结果。
