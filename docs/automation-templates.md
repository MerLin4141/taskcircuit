# Automation templates

Each template pairs an ordinary schema-1 `automations.json` with a trusted runtime config example. Apply the edited JSON using the existing CLI. TaskCircuit stores the resulting Automation and its versions through the same path as any other applied rule.

| Template                                                                   | Default trigger                                                    | Agent       | Default notice |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------- | -------------- |
| [GitHub Issue Fixer](../examples/templates/github-issue-fixer/README.md)   | Issue opened in an allowlisted repository by an allowlisted sender | Codex       | Local console  |
| [Webhook Task Runner](../examples/templates/webhook-task-runner/README.md) | Signed JSON POST                                                   | Claude Code | Local console  |

## Copy, edit, and apply

From a TaskCircuit source checkout, install dependencies and build the CLI with `npm ci` and `npm run build`. Use the current checkout's `taskcircuit` executable. If it is not on PATH, run `node "<absolute checkout path>/dist/cli.js"` with the same arguments in each terminal.

For example, copy the GitHub template in PowerShell. Change the folder name to `webhook-task-runner` to use the other template.

```powershell
$template = 'github-issue-fixer'
$source = Join-Path (Get-Location) "examples/templates/$template"
$demo = Join-Path ([IO.Path]::GetTempPath()) ("taskcircuit-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $demo | Out-Null
Copy-Item (Join-Path $source 'automations.json') $demo
Copy-Item (Join-Path $source 'taskcircuit.config.example.json') (Join-Path $demo 'taskcircuit.config.json')
Set-Location $demo
$env:TASKCIRCUIT_HOME = Join-Path $demo 'state'
```

Replace the two placeholder workspace paths with your existing project directory. Set the template's required secret in the Hub's environment and edit any Source-specific values according to its README. Keep the rule name matched to the route's `automationId`. Agent and Source IDs in the rule must match the route. The workspace and Channel IDs must exist in the config.

Start `taskcircuit hub` in the automation directory. Open a second terminal in the same directory and set `$env:TASKCIRCUIT_HOME = Join-Path (Get-Location) 'state'` there as well. The example ingress uses port 8788 and the default management port is 4317. If another runtime uses those ports, choose a free ingress port in the copied config and set a free `TASKCIRCUIT_PORT` in both terminals.

```powershell
taskcircuit apply .\automations.json --dry-run
taskcircuit apply .\automations.json
taskcircuit worker
```

Expect a create action in a fresh home. Dry-run previews changes without writing a rule. Applying an identical file again reports unchanged. When you edit a trusted rule field, applying creates a new immutable Automation version. Existing Roots stay pinned to their original version, and new Roots use the latest version.

## Optional Feishu

Keep the default `["local"]` for console-only notices. For group notices, create a group custom bot and enable signature verification. Add `team-feishu` next to `local` in the copied config's `channels` object.

```json
{
  "local": { "type": "local-console" },
  "team-feishu": {
    "type": "feishu-channel",
    "config": {
      "webhookUrlEnv": "TASKCIRCUIT_FEISHU_WEBHOOK_URL",
      "signingSecretEnv": "TASKCIRCUIT_FEISHU_SIGNING_SECRET"
    }
  }
}
```

Set both variables in the Hub's launch environment and keep their values out of the JSON files. Change the rule's `notify` to `["local", "team-feishu"]`. Start or restart the Hub to load the Channel, then dry-run and apply the updated rule. Feishu sends notices to the group. Use the local Inbox and Answer commands to respond. See the [Feishu setup guide](feishu-channel.md).
