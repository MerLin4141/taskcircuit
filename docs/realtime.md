# 实时变化流

External Event 是触发工作的外部事实；Runtime Change 是 Hub 已提交的内部状态变化。`runtime_changes.sequence` 为 SQLite 自增整数，按提交持久化，作为重放游标；payload 只包含状态、序号等必要字段，不包含完整上下文、输出、外部会话 ID、密钥或数据库路径。数据库触发器与状态更新处于同一事务，回滚不会留下 change。心跳和轮询不产生 change。

`GET /api/stream?after=N` 先按 sequence 读取大于 N 的持久记录，再持续从同一游标查询后续变化；不依赖先订阅内存事件，重放到实时之间不会漏读。未提供 after 时使用 `Last-Event-ID`，两者均未提供时从 0 开始。事件格式为 `id: N`、`event: change`、`data: JSON`；定期发送 `: ping` comment。客户端应按 sequence 去重，流提供至少一次观察，不承诺恰好一次。

`GET /api/stream/head` 返回当前 sequence。Hub 启动和每分钟维护时最多保留最近 10,000 条；游标在已清理范围内时连接返回 409 `stream_cursor_expired`。已连接客户端落后时收到 `event: resync` 并断开，应刷新状态再连接。`taskcircuit watch --after N` 可观察变化。

`GET /api/state` 返回有限的最近工作、活跃工作、Inbox、活跃计划和 sequence。它们不是严格原子的快照与游标：客户端应按 sequence 去重，必要时完整刷新。`taskcircuit watch` 默认从 0 重放；游标过期时应刷新并使用当前 head。
