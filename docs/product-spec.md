# TaskCircuit 产品规格

TaskCircuit 是面向 CLI Agent 的本地持久化任务运行时。Work Item 可跨 Execution、人工问答、计划恢复和失败重试持续存在；Codex、Claude Code 和 mock 通过 Adapter 接入。Hub 提供 SQLite、调度、变化流、通知和人工收件箱。

V0.1 支持 Windows 用户级 Startup Task 与 Job Object 生命周期管理；不安装 Windows Service，不实现 Desktop、外部通知通道或执行沙箱。
