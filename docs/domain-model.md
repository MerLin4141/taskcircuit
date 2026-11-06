# 领域模型

Work Item 表示一件长期工作，包含按 sequence 排列的 Execution。Agent Session 属于一个 Work Item，TaskCircuit UUID 与外部 CLI session/thread ID 是不同标识。回答后原 Execution 保持 waiting_input，新的 queued Execution 引用原 Session。Interaction 保存 ask 和 answer，只能解决一次。

Event 按 source/type 匹配配置路由和 Agent Profile。Profile 指定 adapter、可选模型及 isolation；缺省 `trusted-local`。`sandboxed` 为未来契约，当前配置会拒绝。Profile 可指定绝对路径 `workspaceRoot`；未指定时使用系统临时目录下的工作区根。

Worker 经 HTTP 获得当前执行需要的数据。工作区根独立于状态根，独立目录不代表操作系统安全隔离。
