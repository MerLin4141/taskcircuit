# 领域模型

Work Item 表示长期工作；Execution 表示一次执行，记录触发来源与重试链路。Agent Session 与外部 CLI 会话 ID 分开；Interaction 保存人工问题和回答。Event 是外部触发事实，经 Route 选择 Agent Profile。

Schedule 和 Schedule Firing 描述持久触发；Runtime Change 是已提交状态变化的可重放记录。Notification 是需要通知人的事项，Delivery 记录通道投递及租约。

Worker presence 记录 Worker ID、状态及最近心跳；Hub 根据最近心跳计算 online/stale，不将心跳写入 Runtime Change。Windows Runtime 身份与 PID 文件为本地运行管理信息，不替代领域持久状态。
