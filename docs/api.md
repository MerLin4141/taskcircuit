# HTTP API

请求和响应为 JSON，时间为 UTC ISO-8601。错误格式为 `{ "error": { "code": "...", "message": "..." } }`。

- `GET /api/health`：服务状态。
- `POST /api/events`：`{source,type,payload}`；路由匹配后创建 Event、Work Item 和首个 Execution。
- `GET /api/work-items`：最近工作、最新执行、待回答问题。
- `GET /api/work-items/:id`：工作、Profile、执行、Session 和交互。CLI 的 `work` 输出隐藏完整外部会话 ID。
- `POST /api/executions/claim`：`{workerId}`；返回执行、profile、事件、历史回答、会话和租约令牌；无任务时 204。
- `POST /api/executions/:id/heartbeat`：`{workerId,leaseToken}`。
- `POST /api/executions/:id/result`：`{workerId,leaseToken,result}`；支持 completed、needs_input、failed。旧租约返回 409。
- `POST /api/interactions/:id/answer`：`{answer}`；重复回答返回 409，回答在事务中创建恢复执行。

API 暴露外部会话 ID 给 Worker；仅用于可信本机，不应暴露到公网。
