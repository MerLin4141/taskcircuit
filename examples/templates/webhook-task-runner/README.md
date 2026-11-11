# Webhook Task Runner

`Signed webhook → webhook.task → webhook-task → Claude Code → local console or Feishu`

A system that can sign a JSON request can ask Claude Code to perform work in one configured project and report the result. Use a separate secret for this source.

## Configure and start

1. Use Node.js 24+, a built TaskCircuit CLI, an existing project directory, and an installed, authenticated Claude Code CLI. Follow the [template guide](../../../docs/automation-templates.md) to make copies in a separate automation directory with its own state.
2. In your copied `taskcircuit.config.json`, replace both workspace paths under `task-workspace` with the project's absolute path. Keep the rule's Source, Agent profile, workspace, and name matched to the config. You can choose any configured supported Agent profile by updating the route and rule.
3. In PowerShell 7, enter the same strong secret that your sender uses to sign requests, then start the Hub.

   ```powershell
   $env:TASKCIRCUIT_WEBHOOK_SECRET = Read-Host 'Task webhook secret' -MaskInput
   taskcircuit hub
   ```

4. From another terminal in the same automation directory, using the same management port and state settings, preview and apply the rule.

   ```powershell
   taskcircuit apply .\automations.json --dry-run
   taskcircuit apply .\automations.json
   taskcircuit worker
   ```

The first preview reports a create action without writing a definition. The first apply creates the rule, and reapplying the identical file leaves it unchanged. An edited rule creates a new version for new Roots. Existing Roots keep their original version.

The default sends notices to the local console. Add `team-feishu` before starting the Hub and set the rule's `notify` to `["local", "team-feishu"]` to also receive group notices. See [optional Feishu setup](../../../docs/automation-templates.md#optional-feishu).

## Send a signed task and follow the run

POST a JSON object such as `{"taskId":"task-1","text":"Summarize the local project checks"}` to `http://127.0.0.1:8788/integrations/webhook/task-webhook`. Send `X-TaskCircuit-Signature-256` as the HMAC-SHA256 signature of the exact body bytes with the `sha256=` prefix, and `X-TaskCircuit-Delivery` as a unique delivery ID. Reuse that ID and body for retries. A `202` means TaskCircuit accepted the delivery. See the [copyable PowerShell signing example](../../../docs/webhook-source.md#send-a-request). For a remote sender, forward only this integration path through your own HTTPS proxy and preserve the original bytes and headers.

Open a third terminal with the same state and management settings to inspect the run. Replace the example IDs with the values returned by the CLI.

```powershell
taskcircuit root list
taskcircuit root show <root-id>
taskcircuit inbox
taskcircuit answer <interaction-id> "<answer>"
```

The default rule allows up to six runs over one hour. A completed Root produces a completion notice. A request for input is answered through the local CLI, including when you receive a Feishu notice.

The payload supplies external context. Trusted config and the applied rule set the Agent, workspace, capabilities, limits, and notifications. Restrict access to the signing key and scope the workspace to one project. Trusted Local provides no OS-level filesystem or network isolation.
