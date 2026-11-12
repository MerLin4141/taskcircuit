# TaskCircuit

**English** | [简体中文](README.zh-CN.md)

A durable local runtime for CLI agent automation.

TaskCircuit can turn a GitHub Issue or a signed webhook into an Automation for Codex or Claude Code. It runs the Agent in your chosen project and sends completion, failure or input notices to the local console or Feishu.

```text
GitHub / Webhook → TaskCircuit → Codex / Claude Code → Local console / Feishu
```

**Start with the [v0.4 Quick Start](docs/quickstart-v0.4.md).** Try the built-in Mock Agent locally without provider credentials, then choose a template. For real Agents, install and authenticate your CLI yourself. See [Agent configuration](docs/agents.md).

## Automation templates

Start with [GitHub Issue Fixer](examples/templates/github-issue-fixer/README.md) for local issue work or [Webhook Task Runner](examples/templates/webhook-task-runner/README.md) for signed task requests. Copy and edit the paired config and rules, then preview and apply them with the existing CLI. See the [v0.4 template guide](docs/automation-templates.md).

## Reliability and storage

Lease fencing rejects stale results. Unknown execution outcomes require operator verification rather than blind replay. Result receipts and bounded reconciliation confirm a Hub commit after a lost response; they do not guarantee exactly-once external side effects. A local process termination cannot retract a request already sent, and descendants that escape process-tree control can survive.

**Upgrade from v0.1.2 is one way.** Before upgrading, stop the old runtime, resolve active or uncertain work, and make an independent backup of the complete user data directory. The first v0.2 open creates a checked SQLite backup in the same home as `taskcircuit-v1-backup-<id>.sqlite` before quarantining the old `taskcircuit.db`; the new database is `taskcircuit-gen2.db`. A failed backup or unsafe legacy state blocks the cutover. Interrupted cutover has guarded recovery; keep the backup and consult the [upgrade guide](docs/upgrade-v0.2.md). Direct downgrade is unsupported: restore your pre-upgrade backup, and note that v0.2 changes will not be copied back.

## Security and limitations

TaskCircuit uses a **Trusted Local** model. The loopback Hub is not user authentication, capability fields are authorization metadata, and neither is an OS-level filesystem or network sandbox. Other processes running as the same user remain inside the trust boundary. Do not use it as a security boundary for untrusted code.

Windows is the primary validated platform. Actual Windows reboot/logon and Linux process-group cleanup have not been verified. The watch stream does not expose every Event/Root/Continue transition; Automation creation requires trusted Agent, event and workspace registration. Cancellation was observed for the managed process; a complete descendant inventory was not independently verified. Real Agent deadline, response-loss, Worker crash and Hub crash were not independently injected against both CLIs.

v0.3 provides Agent, Source, and Channel plugins, including explicitly configured trusted external modules. Plugin top-level code runs with local user permissions. The v0.4 development branch adds active Sources, outbound Feishu and project-specific configuration. See [plugin authoring](docs/plugin-authoring.md) and [declarative rules](docs/declarative-automation.md).

v0.3 does not provide approval workflows, ActionIntent, Outbox, an external-side-effect exactly-once guarantee, GitHub source plugins, Slack or email channels, multi-user access, RBAC, remote Workers, cloud runtime, OS sandbox, or complex token/cost budgets.

## CLI and development

Use `taskcircuit apply`, `automation create/list/show`, `event emit/list/show`, `root list/show`, `inbox`, `answer`, `watch`, `doctor`, `status`, `work`, `schedule`, and Windows `runtime`. Existing commands and `--json` remain available; consult command help for supported arguments. See [architecture](docs/architecture.md), [API](docs/api.md), [roadmap](docs/roadmap.md), [upgrade guide](docs/upgrade-v0.3.md), and [release notes](docs/releases/v0.3.0.md).

```powershell
npm ci
npm run typecheck
npm run format:check
npm test
npm run build
npm audit
```

TaskCircuit is private in npm metadata and is not published to npm. [MIT License](LICENSE). Copyright (c) 2026 MerLin.
