# TaskCircuit

[English](README.md) | **简体中文**

面向 CLI Agent 的持久化自主循环运行时。

TaskCircuit 让事件触发 Codex、Claude Code 或模拟 Agent 的持续工作。Agent 可以继续、提问、稍后再执行或完成；任务状态可跨执行和进程重启保留。

```text
事件 → 自动化 → Root → Agent → 反馈
                       ↑       │
                       └─ 继续
                          提问 / 稍后 / 完成 / 失败 / 停止
```

Root 表示一次自动化生命周期。同一个 Work Item 可以有多次 Execution，并继续同一个 Agent Session。Continue 是建议：再次启动前，系统检查 Root 状态、授权、活动执行、最大运行次数和截止时间；默认最多 8 次、期限 2 小时。Agent 不能通过反馈提高限制、延长期限或更换可信 Agent、工作目录和能力。

## 先试模拟循环

不需要 Agent 登录或 API 密钥。安装 Node.js 24 或更新版本，按照 [v0.3 快速开始](docs/quickstart-v0.3.md) 配置可信本机环境、应用规则文件、发送事件并查看结果。模拟 Agent 会连续两次 Continue，然后 Complete。人工提问使用 `taskcircuit inbox` 和 `taskcircuit answer`。

使用真实 Agent 时，请自行安装并登录 [Codex CLI](https://github.com/openai/codex) 或 [Claude Code](https://code.claude.com/)，并配置 Agent 与事件路由；调用可能消耗服务额度。TaskCircuit 不代替用户登录。详见 [Agent 配置](docs/agents.md) 和 [Phase 6 验证记录](docs/design/v0.2-phase6-real-agent-e2e-report.md)。

## 可靠性与升级

Lease fencing 拒绝过期结果；结果不明时要求人工核实，不盲目重跑。结果回执和有限次数的协调用于确认 Hub 是否提交，不能保证外部副作用恰好一次。终止本地进程无法撤回已发送的请求，脱离进程树控制的后代进程也可能继续运行。

**从 v0.1.2 升级是单向的。** 升级前停止旧运行时，处理活动或结果不明的工作，并独立备份完整用户数据目录。首次打开时，系统先在同一 Home 创建 `taskcircuit-v1-backup-<id>.sqlite` 并检查，再隔离旧 `taskcircuit.db`；新数据库为 `taskcircuit-gen2.db`。备份失败或旧执行状态不安全时会阻止切换。中断后有受保护的恢复路径；请保留备份并查看 [升级指南](docs/upgrade-v0.2.md)。不支持直接降级；回退需恢复升级前备份，v0.2 产生的数据不会自动回写。

## 安全与限制

TaskCircuit 使用 **Trusted Local** 模型。回环地址不是用户认证，能力字段是授权元数据，不是操作系统级文件或网络沙箱；同用户的其他进程仍处于信任边界内。不要把它作为执行不可信代码的安全边界。

Windows 是主要验证平台。尚未验证实际 Windows 重启/登录和 Linux 进程组清理。Watch 不能展示全部 Event/Root/Continue 过程；创建自动化前需要注册可信 Agent、事件和工作目录。取消已观察到受管理进程收到停止信号，但未独立盘点全部后代进程。真实 Agent 的 deadline、响应丢失、Worker 崩溃及 Hub 崩溃未分别对两种 CLI 注入验证。

v0.3 提供 Agent、Source 和 Channel 插件，支持显式配置的可信外部模块。外部插件的顶层代码以本机用户权限运行；通用主动 Source 生命周期尚未实现。详见[插件说明](docs/plugin-authoring.md)和[声明式规则](docs/declarative-automation.md)。

v0.3 不提供审批流程、ActionIntent、Outbox、外部副作用恰好一次保证、GitHub Source 插件、Slack 或邮件通道、多用户、RBAC、远程 Worker、云运行时、OS 沙箱或复杂 token/成本预算。

## 命令与开发

主要命令包括 `taskcircuit apply`、`automation create/list/show`、`event emit/list/show`、`root list/show`、`inbox`、`answer`、`watch`、`doctor`、`status`、`work`、`schedule` 和 Windows `runtime`。旧命令和 `--json` 仍可使用，参数以命令帮助为准。详见 [架构](docs/architecture.md)、[API](docs/api.md)、[路线图](docs/roadmap.md) 和 [升级指南](docs/upgrade-v0.3.md)和[发布说明](docs/releases/v0.3.0.md)。

```powershell
npm ci
npm run typecheck
npm run format:check
npm test
npm run build
npm audit
```

npm 元数据保持 private，本项目不发布到 npm。[MIT License](LICENSE)。Copyright (c) 2026 MerLin。
