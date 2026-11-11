# GitHub Issue Fixer

`GitHub Issue opened → GitHub Source → issue-fixer → Codex → local console or Feishu`

An issue from an allowlisted repository and sender can trigger Codex to inspect an existing local checkout, make warranted edits, run tests, and report its findings. Review the checkout and decide what to commit or publish yourself.

## Configure and start

1. Use Node.js 24+, a built TaskCircuit CLI, a local project checkout, and an installed, authenticated Codex CLI. Use a separate automation directory and state folder. From the TaskCircuit checkout, set up the copies as shown in the [template guide](../../../docs/automation-templates.md).
2. In your copied `taskcircuit.config.json`, replace both workspace paths under `project-workspace` with the absolute path to your checkout. Replace synthetic IDs `1001` and `2001` with your numeric repository and authorized sender IDs. Find them in `repository.id` and `sender.id` in GitHub's webhook delivery payload. If you rename a Source, Agent profile, workspace, or rule, update the matching reference in both files. You can use any configured supported Agent profile. See [GitHub Source setup](../../../docs/github-source.md).
3. In PowerShell 7, set a strong webhook secret in the Hub's terminal. Enter the same value in GitHub's webhook settings.

   ```powershell
   $env:TASKCIRCUIT_GITHUB_WEBHOOK_SECRET = Read-Host 'GitHub webhook secret' -MaskInput
   taskcircuit hub
   ```

4. From another terminal in the same automation directory, using the same management port and state settings, preview and apply the rule.

   ```powershell
   taskcircuit apply .\automations.json --dry-run
   taskcircuit apply .\automations.json
   taskcircuit worker
   ```

The first preview shows a create action without writing a definition. The first apply creates it, and applying the same file again reports it unchanged. Editing the trusted instruction or limits creates a new version. Existing Roots keep the version they started with.

The default sends notices to the local console. For both local and Feishu notices, add `team-feishu` and the two Feishu environment references before starting the Hub. Set the rule's `notify` to `["local", "team-feishu"]`. See [optional Feishu setup](../../../docs/automation-templates.md#optional-feishu).

## Trigger and follow the run

In your GitHub repository, open **Settings → Webhooks → Add webhook**. Use your HTTPS reverse proxy or tunnel as the Payload URL and forward only `/integrations/github/project-github` to the Hub's integration listener at `127.0.0.1:8788`. Preserve the request bytes and headers. Set Content type to `application/json`, enter the matching secret, and select **Issues**. Keep the Hub management port local. A signed setup ping returns `204`. An allowlisted sender can then open an Issue to start a run.

Open a third terminal with the same state and management settings to inspect the run. Replace the example IDs with the values returned by the CLI.

```powershell
taskcircuit root list
taskcircuit root show <root-id>
taskcircuit inbox
taskcircuit answer <interaction-id> "<answer>"
```

Use `inbox` and `answer` when the run requests input. A completed Root produces a completion notice. The rule allows up to eight runs over two hours. Issue comments require a separate route and rule for `github.issue_comment.created`. The default subscribes to Issues only.

Webhook authentication identifies the sender under the configured allowlists. Issue text remains external context and may contain misleading instructions. Keep the workspace scoped to one project. Trusted Local runs under the local user's permissions and provides no OS sandbox. The template directs Codex to leave commits, pushes, PR creation, issue updates, and comments to the operator. Feishu sends notifications to the group and answers stay in the local CLI.
