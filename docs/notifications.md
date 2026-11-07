# 通知与收件箱

Interaction 是等待人工回答的领域事实；Notification 表示需要通知人的事项；Notification Delivery 表示向一个通道的一次独立投递。打开 Interaction 时，Interaction、Runtime Change、Notification 和 Delivery 在同一事务保存。默认问题和最终失败会创建通知；完成通知由路由 `notifyOnCompleted` 显式开启。路由的 `notify` 可选通道列表，默认使用配置的本地通道。

NotificationDispatcher 独立于 Scheduler，通过持久队列和 30 秒租约领取 Delivery，成功标记 sent，失败固定间隔 5 秒重试，最多 3 次。进程中断后过期领取可恢复。Channel 接口接收稳定的 deliveryId，便于未来外部通道去重；目前仅支持 `local-console`，输出结构化一行文字。Delivery 提供至少一次投递，不保证恰好一次：发送成功后、状态提交前崩溃可能导致重发。

回答在同一事务中解决 Interaction 和关联 Notification、取消 queued/claimed Delivery 并生成新 Execution。已开始调用通道的发送无法撤回；回答后的状态不会再被该调用改回 sent，后续也不会继续重试。

`GET /api/inbox` 返回按创建时间从早到晚的 open Interaction，不包含外部 session ID。`taskcircuit inbox` 显示 ID、工作、标题、选项和等待时间；使用 `taskcircuit answer <id> <回答>` 回复。Hub 升级旧数据库时会为已有 open Interaction 补建通知和投递记录。

Windows 后台 Runtime 将本地通知的通用投递记录写入轮转日志；不写完整 Agent 提示词或会话 ID。
