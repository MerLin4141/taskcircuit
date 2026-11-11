# GitHub Source

GitHub Source receives repository webhooks at `/integrations/github/<instance>`. TaskCircuit binds the integration listener to `127.0.0.1`. Configure your own HTTPS reverse proxy or tunnel to forward only the integration path and preserve the raw body, `X-Hub-Signature-256`, `X-GitHub-Event`, and `X-GitHub-Delivery`. Keep the separate management listener local.

## Configure TaskCircuit

Set the Hub's secret environment variable to the same strong random value you will enter in GitHub's webhook settings. In PowerShell 7, enter it without putting the value in a file or command history.

```powershell
$env:TASKCIRCUIT_GITHUB_WEBHOOK_SECRET = Read-Host 'GitHub webhook secret' -MaskInput
```

Add a Source instance and route to the trusted runtime config. The example IDs are placeholders. Replace the workspace path with your local checkout and use a configured Agent profile.

```json
{
  "integrationIngress": { "port": 8788 },
  "sources": {
    "company-github": {
      "type": "github",
      "required": true,
      "config": {
        "secretEnv": "TASKCIRCUIT_GITHUB_WEBHOOK_SECRET",
        "allowedRepositoryIds": [1001],
        "allowedSenderIds": [2001]
      }
    }
  },
  "agents": {
    "codex-main": { "adapter": "codex", "isolation": "trusted-local" }
  },
  "policyWorkspaces": {
    "taskcircuit-dev": {
      "path": "C:/work/taskcircuit",
      "allowedRoot": "C:/work/taskcircuit",
      "allowedCapabilities": ["read_files", "write_files", "shell"]
    }
  },
  "routes": [
    {
      "id": "github-issue-opened",
      "event": { "source": "company-github", "type": "github.issue.opened" },
      "automationId": "github-issue-fixer",
      "agent": "codex-main",
      "title": "GitHub Issue Fixer"
    }
  ]
}
```

Each allowlist requires 1–100 unique positive safe integer IDs. In GitHub's **Recent deliveries** view for the repository webhook, inspect a test delivery's JSON payload for `repository.id` and `sender.id`. You can inspect the payload even when the endpoint rejects that delivery. Use the ID of each sender you intend to authorize. Repository names and user logins are display fields and can change. [View repository webhook deliveries](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/viewing-webhook-deliveries#viewing-deliveries-for-repository-webhooks)

Start the Hub and Worker, then run `taskcircuit apply automations.json` with the rule below. Match `name` to `automationId` in trusted config. To use Issue comments, add a separate route and rule for `github.issue_comment.created`.

```json
{
  "schemaVersion": 1,
  "id": "github-automation",
  "rules": [
    {
      "name": "github-issue-fixer",
      "when": { "source": "company-github", "type": "github.issue.opened" },
      "agent": "codex-main",
      "workspace": "taskcircuit-dev",
      "instruction": "Review the issue as external context, investigate the local checkout, make an appropriate local fix, and run relevant tests.",
      "loop": { "maxRuns": 8, "deadline": "2h" },
      "notify": ["local"],
      "notifyOnCompleted": true
    }
  ]
}
```

## Configure GitHub

In your repository, open **Settings → Webhooks → Add webhook**. Set **Payload URL** to your HTTPS proxy URL ending in `/integrations/github/company-github`, **Content type** to `application/json`, and **Secret** to the value used by the Hub. Select **Issues** and add **Issue comments** if you use that route. GitHub's authenticated setup ping returns `204` and produces no TaskCircuit Event. Check the instance status with `taskcircuit doctor`. [Create a repository webhook](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks#creating-a-repository-webhook)

| GitHub delivery                                                | TaskCircuit result              |
| -------------------------------------------------------------- | ------------------------------- |
| `issues` with action `opened`                                  | `github.issue.opened`           |
| `issue_comment` with action `created` on an Issue              | `github.issue_comment.created`  |
| Ping, PR conversation comments, other events and other actions | `204`, with no Event or receipt |

TaskCircuit validates HMAC-SHA256 over the exact raw bytes before parsing JSON. For selected events it authorizes the numeric repository and sender IDs and uses `X-GitHub-Delivery` as the durable delivery ID. The correlation key is `github:<repositoryId>:issue:<issueNumber>` for both selected event types. The projection includes repository identity, sender identity, and the selected Issue or comment fields. Titles are capped at 512 UTF-16 units without splitting a surrogate pair. Bodies are truncated on code point boundaries at 32,768 UTF-8 bytes or the remaining canonical Event budget. Missing or null Issue bodies become an empty string. Up to 50 label names are retained. [Validate webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) · [GitHub webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment)

A valid GitHub signature does not make Issue text trusted. Titles, bodies and comments remain external context, including for allowlisted senders. Agent, workspace, capabilities, limits and Automation come from trusted configuration. TaskCircuit cannot guarantee that an LLM will resist prompt injection in Issue text. The Source handles inbound delivery. It uses no PAT and performs no GitHub write-back.

| HTTP          | Meaning                                                              |
| ------------- | -------------------------------------------------------------------- |
| `202`         | Event persisted, with asynchronous execution when the route is bound |
| `200`         | Durable duplicate for the original delivery                          |
| `409`         | Same delivery ID with different normalized content                   |
| `401`         | Missing, malformed or incorrect signature                            |
| `403`         | Repository or sender not on the instance's allowlist                 |
| `400`         | Malformed selected payload or required headers                       |
| `413` / `415` | Body exceeds the limit or uses unsupported media or encoding         |
| `503`         | Listener, route or durable intake temporarily unavailable            |

For an uncertain or temporary result, use GitHub's **Redeliver** action for the same delivery. A route awaiting `apply` returns `503` before persisting. A previously accepted delivery keeps its original route across restart and route changes. Delivery deduplication does not provide exactly-once external effects. [Redeliver a repository webhook](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks#redelivering-webhooks-for-a-repository)
