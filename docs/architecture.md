# 架构

Hub 是 Control Plane，负责匹配配置路由、状态事务、HTTP API 和 SQLite；Worker 是 Execution Plane，经 HTTP 领取任务并调用 Agent Adapter。CLI 仅使用 HTTP 操作 Hub；除 Hub 外的组件不访问数据库。配置只在 Hub 启动时读取。SQLite 使用 Node 自带的 node:sqlite 和显式 SQL。

Hub 仅监听回环地址，V0.1 不提供身份认证。租约由 Hub 发放随机令牌并验证所有提交，以拒绝过期领取的结果。到期任务在下一次领取时恢复。
