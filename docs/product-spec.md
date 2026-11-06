# TaskCircuit 产品规格

TaskCircuit 是面向 CLI Agent 的本地持久化任务运行时。Work Item 可跨 Execution、人工问答、计划恢复和失败重试持续存在；Codex、Claude Code 和 mock 均通过 Adapter 接入。Hub 提供 SQLite 持久化、路由和调度。

Phase 3 支持 once、Cron、Later、有限 Retry 和重启恢复；不实现 SSE、消息通道、Desktop 或操作系统定时服务。
