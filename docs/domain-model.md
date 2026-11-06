# 领域模型

Work Item 表示一件长期工作：active、waiting_input、waiting_schedule、completed、failed 或 cancelled。每个工作包含按 sequence 排列的 Execution，分别表示一次执行，状态为 queued、claimed、running、waiting_input、retry_wait、completed、failed 或 cancelled。

Agent Session 属于一个 Work Item，记录 adapter 的外部会话 ID；同一工作回答后的下一次 Execution 引用同一个 Session。Interaction 关联创建它的 Execution，记录 ask、状态和回答；只能从 open 变为 resolved 一次。Event 是外部事实，与执行日志不同；配置路由把 source/type 精确匹配到 Agent Profile。Agent Profile 包含 adapter、model、reasoning 和配置。Worker 是通过 HTTP 租约执行工作的进程，不持有数据库连接。

Phase 1 从 queued 原子领取为 running，到期后可重新领取；结果转为 waiting_input、completed 或 failed。回答在同一事务中解决问题并创建下一个 queued Execution；原 Execution 保持 waiting_input。
