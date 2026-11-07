# 路线图

## V0.1 — Local Durable Agent Runtime：COMPLETE

功能范围冻结为持久工作、执行、Agent Session、人工交互、Codex 和 Claude Code、重试与调度、变化流、收件箱和本地通知，以及 Windows 后台运行时。发布前仅接受 bug、文档、安全和发布打包修复。

## 后续方向（版本顺序和范围暂定）

- V0.2 — Execution Isolation：IsolationProvider、容器、虚拟机或 OS 沙箱、显式工作区挂载、网络策略、凭据隔离。
- V0.3 — Desktop Control Plane：Dashboard、工作、收件箱、计划和运行时健康。
- V0.4 — External Channels & Sources：飞书、Webhook、GitHub 和其他通知通道。
- 更远期：远程 Worker、多用户、RBAC 和云运行时。

Docker 沙箱、远程 Worker、桌面 UI、飞书、Slack、邮件、GitHub Connector、MCP、云部署、自动更新和 MSI 安装器均不属于 V0.1。
