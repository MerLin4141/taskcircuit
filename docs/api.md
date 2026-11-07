# HTTP API

Hub 仅用于可信本机，JSON API 使用 UTC 时间。

- `GET /api/health`、`GET /api/workers`：Hub 健康和 Worker presence；`POST /api/workers/:id/heartbeat` 更新 online/stopped 状态，不产生 Runtime Change。
- `POST /api/events`、`GET /api/work-items`、`GET /api/work-items/:id`、`POST /api/work-items/:id/cancel`：事件和工作。
- `POST /api/executions/claim`、`POST /api/executions/:id/heartbeat`、`POST /api/executions/:id/result`：领取、续租和提交执行。
- `POST /api/interactions/:id/answer`、`GET /api/inbox`、`GET /api/notifications`：人工回答与通知。
- `GET /api/state`：有限快照和流 head，二者不保证严格原子。`GET /api/stream/head` 与 `GET /api/stream?after=N` 支持变化流重放。
- `/api/schedules` 及其 pause/resume/delete 接口管理计划。Windows Startup Task 由 CLI 平台层管理，不通过 Hub 创建。

Execution 的 `error` 可包含 `code`、`message` 和 `retryable`；错误类别及重试语义见 [Agent 适配器](agents.md)。旧的 `agent_execution` 记录保持可读，不需要数据库迁移。
