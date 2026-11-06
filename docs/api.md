# HTTP API

请求和响应为 JSON，时间使用带时区的 ISO-8601，持久化为 UTC。错误格式为 `{ "error": { "code": "...", "message": "..." } }`。Hub 仅用于可信本机。

- `GET /api/health`：服务状态。
- `POST /api/events`：`{source,type,payload}`，匹配路由后创建 Event 与工作。
- `GET /api/work-items`、`GET /api/work-items/:id`：查看工作及执行、会话、交互和计划；`POST /api/work-items/:id/cancel` 取消工作。
- `POST /api/executions/claim`、`POST /api/executions/:id/heartbeat`、`POST /api/executions/:id/result`：领取、续租和提交 `completed`、`needs_input`、`later` 或 `failed`。
- `POST /api/interactions/:id/answer`：回答后创建恢复执行。
- `GET /api/schedules`、`GET /api/schedules/:id`：列出或查看计划。
- `POST /api/schedules`：`{kind:"once",runAt,event:{source,type,payload}}` 或 `{kind:"cron",expression,timezone,event:{source,type,payload}}`；时区缺省 UTC。
- `POST /api/schedules/:id/pause`、`/resume` 和 `DELETE /api/schedules/:id`：暂停、恢复和取消用户计划。Work Item 内部计划随工作状态管理。

计划触发进入 Event Router；API 不允许任意指定 Agent 或执行命令。
