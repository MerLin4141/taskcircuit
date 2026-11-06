# Phase 1 HTTP API

所有请求和响应为 JSON，时间为 UTC ISO-8601。错误为 `{ "error": { "code": "...", "message": "..." } }`。

- `GET /api/health`：返回服务状态。
- `POST /api/events`：`{source,type,payload}`，按配置精确匹配路由并创建事件、工作及首个执行。未匹配返回 404。
- `GET /api/work-items`：最近工作及最近执行、待回答问题。
- `GET /api/work-items/:id`：工作及其 executions、agentSession、interactions。
- `POST /api/executions/claim`：`{workerId}`，返回 execution、agentSession 和 leaseToken；无任务时 204。
- `POST /api/executions/:id/heartbeat`：`{workerId,leaseToken}`。
- `POST /api/executions/:id/result`：`{workerId,leaseToken,result}`，结果类型为 completed、needs_input、failed。过期或错误租约返回 409。
- `POST /api/interactions/:id/answer`：`{answer}`，重复回答返回 409。
