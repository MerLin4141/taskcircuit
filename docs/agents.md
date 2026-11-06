# Agent 适配器

`AgentAdapter.execute` 接收 workItemId、executionId、workingDirectory、instruction、当前事件 context、previousAnswers、externalSessionId 可选 model 和 Adapter 内部使用的 retryAttempt。前两个 ID 仅用于 Adapter 关联，prompt 不包含它们或工作目录、外部会话 ID。首次返回的外部会话 ID 由 Hub 持久化，回答后新执行使用同一 ID。

Codex 使用 `exec --json` 和 `exec resume`；Claude Code 使用 `--print --output-format json` 和 `--resume`。未指定模型时使用用户 CLI 默认值。Agent 原生沙箱能力与 TaskCircuit 的隔离等级是不同概念。

## 响应协议

最终文本必须是纯 JSON：`{"kind":"ask","message":"...","interaction":{"title":"...","text":"...","key":"...","options":["..."]}}`、`{"kind":"complete","message":"..."}`、`{"kind":"fail","message":"...","retryable":true}` 或 `{"kind":"later","message":"...","afterSeconds":2}`（也可用 `runAt` 替代 `afterSeconds`）。Zod 校验类型、非空字段和选项；非法输出产生不可重试的结构化失败；业务失败的 retryable 只是提示，是否重试由运行时的分类和路由策略共同决定。instruction、事件数据和历史回答分别序列化。

## 进程与环境

ProcessRunner 以 argv 直接启动，不使用 shell。`stateRoot` 由 `TASKCIRCUIT_HOME` 或默认 Home 决定；workspaceRoot 由 Profile 的绝对路径、`TASKCIRCUIT_WORKSPACE_ROOT` 或系统临时目录决定。每个工作使用独立子目录，不允许工作目录位于 stateRoot 内。子进程过滤所有 `TASKCIRCUIT_` 变量；Codex 额外按大小写不敏感规则移除 `CODEX_WINDOWS_REGISTERED_CORE`。不记录完整环境或原始 stderr。

当前不声称同 OS 用户的 Agent 无法自行读取数据库；详见 [security-model.md](security-model.md)。真实测试分别为 `npm run test:e2e:codex` 与 `npm run test:e2e:claude`，可能消耗用户的服务额度。
