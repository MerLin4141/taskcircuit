# TaskCircuit v0.4 Quick Start

TaskCircuit connects a Source to an Automation, runs an Agent in a project you choose, and delivers the result as a Notification.

```text
GitHub Issues or signed Webhook → Automation → Codex or Claude Code → Local console or Feishu
```

## Try locally with Mock

From a checkout with Node.js 24 or newer, run `npm ci` and `npm run build`. In PowerShell, save the path to the CLI and create a fresh state directory. Use an unused management port.

```powershell
$tc = (Resolve-Path .\dist\cli.js).Path
$demo = Join-Path ([IO.Path]::GetTempPath()) ('TaskCircuit Mock ' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $demo | Out-Null
$env:TASKCIRCUIT_HOME = Join-Path $demo 'state'
$env:TASKCIRCUIT_PORT = '54321'
Remove-Item Env:TASKCIRCUIT_CONFIG -ErrorAction SilentlyContinue
Set-Location $demo
node $tc doctor
node $tc hub
```

In each additional terminal set `$tc`, `TASKCIRCUIT_HOME`, and `TASKCIRCUIT_PORT` to the same values. Use a directory without a `taskcircuit.config.json` and leave `TASKCIRCUIT_CONFIG` unset for the built-in demo.

```powershell
# Worker terminal
node $tc worker

# Operator terminal
node $tc emit demo.color
node $tc inbox
node $tc answer '<interaction-id>' '蓝色'
node $tc status
```

Copy the interaction ID shown by Inbox before answering. The Mock asks one question, resumes and completes. The Hub terminal shows the local input notice when it is delivered. Stop the Hub and Worker with Ctrl+C when finished.

## Set up GitHub Issue Fixer

1. Copy the two files from [GitHub Issue Fixer](../examples/templates/github-issue-fixer/README.md) into a project automation directory. Rename the copied config example to `taskcircuit.config.json`. Edit the project paths, numeric repository and sender IDs, and matching Agent settings. Install and authenticate Codex CLI yourself.
2. In the Hub terminal, enter the webhook secret using PowerShell 7's masked prompt. Use a fresh `TASKCIRCUIT_HOME` for the new project and share that home and management port between terminals.

   ```powershell
   $env:TASKCIRCUIT_GITHUB_WEBHOOK_SECRET = Read-Host 'GitHub webhook secret' -MaskInput
   taskcircuit doctor --config .\taskcircuit.config.json
   ```

   If the checkout CLI is outside PATH, replace `taskcircuit` in the examples with `node "<absolute checkout path>/dist/cli.js"`. Doctor can run before the Hub starts. Resolve `FAIL` entries first. An offline Hub is a warning. Doctor checks credential names and presence, local config and available Agent CLIs. Its checks do not send provider requests or verify Agent login.

3. Choose foreground or managed startup below, then preview and apply the Automation from an operator terminal. The example uses the copied files in the current directory.

   ```powershell
   taskcircuit apply .\automations.json --dry-run
   taskcircuit apply .\automations.json
   ```

4. In GitHub, point the repository webhook at an operator-managed HTTPS proxy or tunnel. Forward only `/integrations/github/project-github` to the integration listener, typically `127.0.0.1:8788`. Keep the separate management listener, typically `127.0.0.1:4317`, local. Subscribe to **Issues** with JSON content and the same secret, then open an Issue as an allowlisted sender. See the [GitHub Source guide](github-source.md).
5. Run `taskcircuit root list` to see the Automation run. Use `taskcircuit inbox` and `taskcircuit answer '<interaction-id>' '<answer>'` for questions. Review local edits and test results yourself. Local-console is the default. To also receive a group notification, follow [optional Feishu setup](automation-templates.md#optional-feishu). Answers stay in the local CLI.

A signed synthetic GitHub request is the local validation path for this phase. Public GitHub delivery, real Agent execution through these templates and real group receipt remain release-candidate checks. For a local signed request without GitHub, use the [Webhook Task Runner](../examples/templates/webhook-task-runner/README.md).

## Choose how to run

### Foreground Hub and Worker

Run these in separate terminals using the same state home and management port.

```powershell
taskcircuit hub --config .\taskcircuit.config.json
taskcircuit worker --config .\taskcircuit.config.json
```

An explicit `--config` wins over `TASKCIRCUIT_CONFIG`. Both accept a relative path resolved from the invoking terminal. With neither selection, TaskCircuit looks for `taskcircuit.config.json` in the current directory, then uses the built-in defaults. A missing explicitly selected file stops startup. Relative plugin paths use the selected file's directory.

### Managed Windows Runtime

After checking the selected configuration with Doctor, install the startup task using the same home that later runtime commands will address.

```powershell
taskcircuit runtime install --config .\taskcircuit.config.json
taskcircuit runtime start
taskcircuit runtime status
```

Install pins the absolute configuration path for later starts, or pins the built-in selection when there is no config file. Starting from another directory uses the pinned selection. Reinstall an older task to pin a project config. Use `taskcircuit runtime stop` to stop it, and `taskcircuit runtime uninstall` to remove the task while preserving state.

A PowerShell `$env:NAME = ...` assignment applies only to that shell and its descendants. For the managed task, arrange for required secrets to be available in the launch environment of the scheduled user through your own persistent environment mechanism. TaskCircuit stores the config path in the task, and credentials stay in the operator-managed environment. Restart the Hub or managed Runtime after changing a secret or Feishu hook URL. Source or Channel health reflects configuration and runtime state, with no live provider probe from Doctor.

Trusted Local runs under the local user's permissions. Keep the workspace scoped to the project, load only trusted plugins, and treat external event text as context.
