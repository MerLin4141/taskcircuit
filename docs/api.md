# HTTP API

JSON API 使用 UTC 时间；错误一般为 `{ "error": { "code": "...", "message": "..." } }`。Hub 仅用于可信本机。

- `GET /api/health`：服务状态。
- `POST /api/events`：`{source,type,payload}`，经路由创建工作。
- `GET /api/work-items`、`GET /api/work-items/:id`、`POST /api/work-items/:id/cancel`：查看或取消工作。
- `POST /api/executions/claim`、`POST /api/executions/:id/heartbeat`、`POST /api/executions/:id/result`：领取、续租和提交执行。
- `POST /api/interactions/:id/answer`：回答并生成恢复执行。
- `GET /api/inbox`：按创建时间从早到晚返回最多 100 条 open Interaction。`GET /api/notifications` 查看通知及投递。
- `GET /api/state`：有限状态快照及流 head；快照与游标不保证严格原子。
- `GET /api/stream/head`：当前 sequence；`GET /api/stream?after=N`：按 sequence 重放并实时读取 SSE，也支持 `Last-Event-ID`。游标过期返回 HTTP 409；已连接流过期发送 resync 事件。
- `GET /api/schedules`、`GET /api/schedules/:id`、`POST /api/schedules`、`POST /api/schedules/:id/pause`、`/resume` 和 `DELETE /api/schedules/:id`：管理持久计划。
