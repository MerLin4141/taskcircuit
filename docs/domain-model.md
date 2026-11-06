# 领域模型

Work Item 表示长期工作；Execution 表示一次进程执行，记录 sequence、triggerKind、parentExecutionId 和 retryAttempt。triggerKind 为 initial、human_answer、retry 或 scheduled_resume，重试次数独立于 sequence。

Agent Session 的 TaskCircuit UUID 与外部 session ID 不同；回答、Later 和已建立会话的 Retry 均继续同一 Session。Interaction 保存问题和回答。Event 是外部事实，经 Route 选择 Agent Profile。

Schedule 可为 once 或 cron，状态为 active、paused、completed 或 cancelled；owner 区分用户计划与 Work Item 的 later/retry。Schedule Firing 用计划与计划时间唯一标识一次触发。

Work Item 在执行时为 active；等待人工输入为 waiting_input；等待有效后续计划为 waiting_schedule；成功为 completed，不可重试或重试耗尽为 failed，取消为 cancelled。
