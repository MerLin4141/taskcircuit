# TaskCircuit

[English](README.md) | **简体中文**

面向 CLI Agent 的本地持久化自动化运行时。

TaskCircuit 可以把 GitHub Issue 或签名 Webhook 变成自动化，让 Codex 或 Claude Code 在指定的项目目录中工作，并通过本地控制台或飞书报告完成、失败或待回答的问题。

```text
GitHub / Webhook → TaskCircuit → Codex / Claude Code → 本地控制台 / 飞书
```

**从 [v0.4 快速开始](docs/quickstart-v0.4.md) 入手。** 先用内置 Mock 在本地验证，再选择自动化模板。使用真实 Agent 时，请自行安装并登录对应 CLI。详见 [Agent 配置](docs/agents.md)。

## 自动化模板

用 [GitHub Issue Fixer](examples/templates/github-issue-fixer/README.md) 在本地处理 Issue，或用 [Webhook Task Runner](examples/templates/webhook-task-runner/README.md) 接收签名任务请求。复制配置和规则，编辑后用现有命令预览并应用。详见 [v0.4 自动化模板指南](docs/automation-templates.md)。

## 可靠性与升级

Lease fencing 拒绝过期结果；结果不明时要求人工核实，不盲目重跑。结果回执和有限次数的协调用于确认 Hub 是否提交，不能保证外部副作用恰好一次。终止本地进程无法撤回已发送的请求，脱离进程树控制的后代进程也可能继续运行。

**从 v0.1.2 升级是单向的。** 升级前停止旧运行时，处理活动或结果不明的工作，并独立备份完整用户数据目录。首次打开时，系统先在同一 Home 创建 `taskcircuit-v1-backup-<id>.sqlite` 并检查，再隔离旧 `taskcircuit.db`；新数据库为 `taskcircuit-gen2.db`。备份失败或旧执行状态不安全时会阻止切换。中断后有受保护的恢复路径；请保留备份并查看 [升级指南](docs/upgrade-v0.2.md)。不支持直接降级；回退需恢复升级前备份，v0.2 产生的数据不会自动回写。

## 安全与限制

TaskCircuit 使用 **Trusted Local** 模型。回环地址不是用户认证，能力字段是授权元数据，不是操作系统级文件或网络沙箱；同用户的其他进程仍处于信任边界内。不要把它作为执行不可信代码的安全边界。

Windows 是主要验证平台。尚未验证实际 Windows 重启/登录和 Linux 进程组清理。Watch 不能展示全部 Event/Root/Continue 过程；创建自动化前需要注册可信 Agent、事件和工作目录。取消已观察到受管理进程收到停止信号，但未独立盘点全部后代进程。真实 Agent 的 deadline、响应丢失、Worker 崩溃及 Hub 崩溃未分别对两种 CLI 注入验证。

v0.3 提供 Agent、Source 和 Channel 插件，支持显式配置的可信外部模块。外部插件的顶层代码以本机用户权限运行；v0.4 开发分支加入主动 Source、飞书通知和项目级配置选择。详见[插件说明](docs/plugin-authoring.md)和[声明式规则](docs/declarative-automation.md)。

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
