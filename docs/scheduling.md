# 持久化调度

Schedule 分为 `once` 与 `cron`。用户计划触发 Event，再经过原有路由创建 Work Item；Later 和 Retry 创建属于 Work Item 的一次性计划，到期创建新的 Execution。计划、触发记录、Event 和 Execution 存在 SQLite，内存定时器只用于轮询，不保存业务时间。

每次触发在同一事务内写 `schedule_firings`、事件及路由结果，或写恢复 Execution，并推进 Schedule；`(schedule_id, scheduled_for)` 唯一。事务失败全部回滚，Hub 重启后仍可处理到期项。不同进程的调度器通过 SQLite 写事务和唯一约束避免重复。

Cron 使用标准五字段和明确 IANA 时区，缺省 UTC。`cron-parser` 使用 MIT 许可，支持时区和夏令时；禁止随机 `H` 表达式。停机期间错过多次时采用固定 `fire_once`：恢复后触发一次，然后从当前时间计算下一个未来发生时间，不逐次补跑。Once 到期或逾期触发一次。暂停后恢复的过期计划按同样规则处理。

Agent 的 Later 表示本次执行正常结束：Execution 为 completed，Work Item 为 waiting_schedule。结果必须只包含 `afterSeconds` 或 `runAt` 其中之一；到期新 Execution 使用 `scheduled_resume`，复用已有 Session。

Retry 是失败后的运行时决策。路由可设置 `retryPolicy`：`maxAttempts` 包括首次执行；fixed 延迟固定，exponential 为 `min(initialDelaySeconds * 2^(retryAttempt-1), maxDelaySeconds)`。`retryAttempt` 从 0 开始，人工回答或 Later 后重新开始计数。可重试错误与策略同时允许时创建 `retry` 计划；协议和认证错误不重试。Agent 的 `retryable` 是提示，最终由 Runtime 的错误分类和策略决定。

计划在配置中可用 `schedules` 声明：`[{"id":"daily","cron":"0 9 * * *","timezone":"Asia/Shanghai","event":{"source":"local","type":"demo.cron","payload":{}}}]`。Hub 首次看到该 ID 时创建持久计划；之后不以配置覆盖已有状态，调整或取消使用 API。CLI 可使用 `taskcircuit schedule add --cron "0 9 * * *" --timezone Asia/Shanghai --event demo.cron`。

轮询默认 1000ms，Hub CLI 可通过 `TASKCIRCUIT_SCHEDULER_INTERVAL_MS` 设置。测试可注入 Clock 并手动 tick。取消 Work Item 会取消其活动一次性计划，不影响独立用户 Cron 计划。
