# TaskCircuit

**English** | [简体中文](README.zh-CN.md)

A durable autonomous loop runtime for CLI agents.

TaskCircuit turns an event into persistent work for Codex, Claude Code, or a mock agent. The agent can continue, ask for input, wait until later, or finish while TaskCircuit retains the work across executions and process restarts.

```text
Event → Automation → Root → Agent → Feedback
                             ↑         │
                             └─ Continue
                                  Ask / Later / Complete / Failed / Stop
```

A Root represents one automation lifecycle. A Work Item can have multiple Executions that resume the same Agent Session. A Continue is a proposal: before another run, TaskCircuit checks the Root state, authorization, active execution, maximum run count and deadline. The defaults are eight runs and two hours. Feedback cannot increase those limits or change the trusted Agent, workspace, or capabilities.

## Try the mock loop

No Agent login or API credential is needed. Install Node.js 24 or newer, then follow the [v0.2 Quick Start](docs/quickstart-v0.2.md) to build, register a trusted local configuration, start Hub and Worker, create an Automation, emit an Event, and inspect the Root. The mock returns Continue twice and then Complete. `taskcircuit doctor`, `taskcircuit inbox`, and `taskcircuit answer` are available for diagnostics and human input.

For real Agents, install and authenticate [Codex CLI](https://github.com/openai/codex) or [Claude Code](https://code.claude.com/) yourself and configure an Agent profile and event route. Calls may consume provider quota. TaskCircuit does not perform login. See [Agent configuration](docs/agents.md) and the [Phase 6 evidence](docs/design/v0.2-phase6-real-agent-e2e-report.md).

## Reliability and storage

Lease fencing rejects stale results. Unknown execution outcomes require operator verification rather than blind replay. Result receipts and bounded reconciliation confirm a Hub commit after a lost response; they do not guarantee exactly-once external side effects. A local process termination cannot retract a request already sent, and descendants that escape process-tree control can survive.

**Upgrade from v0.1.2 is one way.** Before upgrading, stop the old runtime, resolve active or uncertain work, and make an independent backup of the complete user data directory. The first v0.2 open creates a checked SQLite backup in the same home as `taskcircuit-v1-backup-<id>.sqlite` before quarantining the old `taskcircuit.db`; the new database is `taskcircuit-gen2.db`. A failed backup or unsafe legacy state blocks the cutover. Interrupted cutover has guarded recovery; keep the backup and consult the [upgrade guide](docs/upgrade-v0.2.md). Direct downgrade is unsupported: restore your pre-upgrade backup, and note that v0.2 changes will not be copied back.

## Security and limitations

TaskCircuit uses a **Trusted Local** model. The loopback Hub is not user authentication, capability fields are authorization metadata, and neither is an OS-level filesystem or network sandbox. Other processes running as the same user remain inside the trust boundary. Do not use it as a security boundary for untrusted code.

Windows is the primary validated platform. Actual Windows reboot/logon and Linux process-group cleanup have not been verified. The watch stream does not expose every Event/Root/Continue transition; Automation creation requires trusted Agent, event and workspace registration. Cancellation was observed for the managed process; a complete descendant inventory was not independently verified. Real Agent deadline, response-loss, Worker crash and Hub crash were not independently injected against both CLIs.

v0.2 does not provide approval workflows, ActionIntent, Outbox, an external-side-effect exactly-once guarantee, plugin architecture, GitHub source plugins, Slack or email channels, multi-user access, RBAC, remote Workers, cloud runtime, OS sandbox, or complex token/cost budgets.

## CLI and development

Use `taskcircuit automation create/list/show`, `event emit/list/show`, `root list/show`, `inbox`, `answer`, `watch`, `doctor`, `status`, `work`, `schedule`, and Windows `runtime`. Existing commands and `--json` remain available; consult command help for supported arguments. See [architecture](docs/architecture.md), [API](docs/api.md), [roadmap](docs/roadmap.md), and [release notes](docs/releases/v0.2.0.md).

```powershell
npm ci
npm run typecheck
npm run format:check
npm test
npm run build
npm audit
```

TaskCircuit is private in npm metadata and is not published to npm. [MIT License](LICENSE). Copyright (c) 2026 MerLin.
