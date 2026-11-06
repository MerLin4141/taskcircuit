# TaskCircuit 产品规格

TaskCircuit 是面向 CLI Agent 的本地持久化任务运行时。Work Item 可跨 Execution、人工问答、计划恢复和失败重试持续存在；Codex、Claude Code 和 mock 均通过 Adapter 接入。Hub 提供 SQLite 持久化、路由、调度、变化流、通知和人工收件箱。

Phase 4 提供 SSE 重放和本地通知投递；不实现 Desktop、外部通知通道、操作系统定时服务或执行沙箱。
