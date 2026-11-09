# HTTP API

Hub 仅用于可信本机，JSON API 使用 UTC 时间。

- `GET /api/health`、`GET /api/workers`：Hub 健康和 Worker presence；`POST /api/workers/:id/heartbeat` 更新 online/stopped 状态，不产生 Runtime Change。
- `POST /api/events`、`GET /api/work-items`、`GET /api/work-items/:id`、`POST /api/work-items/:id/cancel`：事件和工作。
- `POST /api/executions/claim`、`POST /api/executions/:id/heartbeat`、`POST /api/executions/:id/result`：领取、续租和提交执行。
- `POST /api/interactions/:id/answer`、`GET /api/inbox`、`GET /api/notifications`：人工回答与通知。
- `GET /api/state`：有限快照和流 head，二者不保证严格原子。`GET /api/stream/head` 与 `GET /api/stream?after=N` 支持变化流重放。
- `/api/schedules` 及其 pause/resume/delete 接口管理计划。Windows Startup Task 由 CLI 平台层管理，不通过 Hub 创建。

Execution 的 `error` 可包含 `code`、`message` 和 `retryable`；错误类别及重试语义见 [Agent 适配器](agents.md)。旧的 `agent_execution` 记录保持可读，不需要数据库迁移。 新版 Worker 应与支持回执的新 Hub 一起升级；旧 Hub 不提供确认接口，新版 Worker 无法确认其提交结果，不会因此重新执行 Agent。

## 执行结果回执（v0.1.2 Release Candidate）

`POST /api/executions/:id/result` 可选同时提供 `submissionId` 和 `resultDigest`。两者同时省略时保留旧语义：首次成功返回 `{ "ok": true }`，终态再次提交仍返回 409；旧客户端和历史记录不会自动获得回执。新客户端使用 UUID v4 作为一次结果的固定提交 ID，并对结果的 JSON 线格式计算 SHA-256。摘要版本 1 对 JSON 对象键按 JavaScript UTF-16 字符串顺序排序，数组保留原顺序，字符串和数字采用 JavaScript `JSON.stringify` 表示；首先将结果转换成 JSON 线值（对象中的 `undefined` 属性省略）。接收端独立计算并检查摘要。跨语言实现需要使用相同的 JSON 数值和字符串规则，不能依赖默认对象迭代顺序；SHA-256 碰撞风险不为零，摘要也不是保密或身份认证机制。

新协议首次有效提交返回 `status: accepted` 和回执；完全相同的 execution ID、submission ID、摘要及结果重放返回 `status: already_committed`，不会再次创建交互、计划或通知。相同 ID 不同摘要或不同结果返回 409。失效租约不能提交新的结果；已接受结果的完全相同重放仅返回既有回执，不恢复写权限。这是对携带新字段的请求的行为变化；原有不带字段请求仍按原行为处理。

`GET /api/executions/:executionId/result-submissions/:submissionId?digest=<sha256>` 只读查询：200 的 `status` 为 `committed` 或 `not_found`；同一提交 ID 的摘要不匹配返回 409。查询不续租，也不改变工作状态。回执只包含执行 ID、提交 ID、摘要、接受时间及提交时状态，不包含租约令牌、凭据或外部会话 ID。异常响应仅供诊断，不能推断外部动作未发生。

回执与执行更新同一 SQLite 写事务提交，存放于对应 Work Item 的 `metadata.taskcircuitResultReceiptsV1`，每个 Execution 至多一条；因此进程重启仍可确认，无需 Migration 5。现有记录不被补造回执；旧版本不认识该附加字段，保持原有数据和请求语义。回执随工作项长期保存，工作项执行次数较多时 metadata 会增长；将来若需要独立索引、清理策略或更严格的跨版本约束，应单独评估迁移。该接口沿用 Trusted Local 模型，没有新增跨用户访问控制。

Worker 对一次逻辑结果只生成一次提交 ID；响应丢失后先查询回执，确认未提交且租约仍在保守有效期内才以相同 ID 和摘要重试。查询及重试有界；失权后只查询、不再重提。确认不了时保留不确定状态，不重新运行 Agent。结果回执只确认 Hub 的 SQLite 提交，不提供外部 API 恰好一次保证。
