# 领域模型

Work Item 表示长期工作；Execution 表示一次进程执行，记录 sequence、triggerKind、parentExecutionId 和 retryAttempt。Agent Session 保存与 TaskCircuit 自身 ID 分开的外部会话标识；Interaction 保存问题和回答。Event 是外部触发事实，经 Route 选择 Agent Profile。

Schedule 可以是 once 或 cron；Schedule Firing 唯一标识一次触发。Work Item 状态为 active、waiting_input、waiting_schedule、completed、failed 或 cancelled。

Runtime Change 是已提交状态变化的可重放记录，与外部 Event 不同；单调 sequence 用作流游标。Notification 是需要通知人的事项，Delivery 记录向一个 Channel 的投递状态及租约。Interaction 和 Notification 各自持久化、通过 interaction ID 关联。
