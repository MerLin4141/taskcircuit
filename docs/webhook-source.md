# Generic Webhook Source

TaskCircuit receives Generic Webhook requests on a dedicated HTTP listener bound to 127.0.0.1. Its management API uses a separate port. For remote senders, configure your own HTTPS reverse proxy or tunnel to forward the exact integration paths to the loopback ingress. Preserve the original body bytes and the signature and delivery headers. TaskCircuit does not run that proxy or terminate TLS.

## Configure the Hub

Create a dedicated environment variable for the secret in the Hub's launch environment. For PowerShell 7, one way to enter it without writing it into the config is:

```powershell
$env:TASKCIRCUIT_WEBHOOK_SECRET = Read-Host 'Webhook secret' -MaskInput
```

Use a distinct, strong value for each instance. The Hub resolves the reference once at startup. Restart it after rotation and update the sender to match.

Example trusted runtime config. Replace the workspace paths with an existing local directory:

```json
{
  "integrationIngress": { "port": 8788, "maxConcurrent": 32 },
  "sources": {
    "task-webhook": {
      "type": "webhook",
      "required": true,
      "config": {
        "secretEnv": "TASKCIRCUIT_WEBHOOK_SECRET",
        "eventType": "webhook.task",
        "deliveryHeader": "x-taskcircuit-delivery",
        "correlationField": "taskId"
      }
    }
  },
  "agents": {
    "mock-demo": { "adapter": "mock", "isolation": "trusted-local" }
  },
  "policyWorkspaces": {
    "safe": {
      "path": "C:/taskcircuit-workspace",
      "allowedRoot": "C:/taskcircuit-workspace",
      "allowedCapabilities": ["read_files"]
    }
  },
  "routes": [
    {
      "id": "webhook-task",
      "event": { "source": "task-webhook", "type": "webhook.task" },
      "automationId": "webhook-task",
      "agent": "mock-demo",
      "title": "Webhook task"
    }
  ]
}
```

The route uses the instance ID, **task-webhook**. The implementation ID **webhook** selects the plugin. The ingress port must differ from the management port. An unused ingress configuration starts no listener. The optional concurrency limit is 1–256, default 32.

Start the Hub and Worker using this config. From a management shell, apply the rule below with `taskcircuit apply automations.json` (or `node dist/cli.js apply automations.json` from a source checkout after building). The rule name must match the route's `automationId`.

```json
{
  "schemaVersion": 1,
  "id": "webhook-example",
  "rules": [
    {
      "name": "webhook-task",
      "when": { "source": "task-webhook", "type": "webhook.task" },
      "agent": "mock-demo",
      "workspace": "safe",
      "instruction": "Process this webhook task",
      "loop": { "maxRuns": 3, "deadline": "5m" }
    }
  ]
}
```

A request to a route waiting for its applied definition returns 503 before writing the delivery. A route intentionally configured without an `automationId` durably accepts an unroutable Event.

## Send a request

Send POST to `/integrations/webhook/task-webhook` with JSON object bytes. The default stable delivery header is `X-TaskCircuit-Delivery`. Reuse the ID and original body bytes for a retry. Assign a different ID to each distinct delivery, even if the payloads match.

The `X-TaskCircuit-Signature-256` value is `sha256=` followed by 64 hex characters. Compute HMAC-SHA256 over the exact bytes sent, using the UTF-8 secret bytes. PowerShell 7 loopback example:

```powershell
$body = '{"taskId":"example-task","text":"Run the configured task"}'
$bytes = [Text.Encoding]::UTF8.GetBytes($body)
$key = [Text.Encoding]::UTF8.GetBytes($env:TASKCIRCUIT_WEBHOOK_SECRET)
$hmac = [Security.Cryptography.HMACSHA256]::new($key)
$signature = 'sha256=' + [Convert]::ToHexString($hmac.ComputeHash($bytes)).ToLowerInvariant()
$hmac.Dispose()

$http = [Net.Http.HttpClient]::new()
$content = [Net.Http.ByteArrayContent]::new($bytes)
$content.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::new('application/json')
$content.Headers.Add('X-TaskCircuit-Delivery', 'demo-delivery-1')
$content.Headers.Add('X-TaskCircuit-Signature-256', $signature)
try {
    $response = $http.PostAsync('http://127.0.0.1:8788/integrations/webhook/task-webhook', $content).GetAwaiter().GetResult()
    [int]$response.StatusCode
    $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $response.Dispose()
} finally {
    $content.Dispose()
    $http.Dispose()
}
```

The listener accepts `application/json` with optional UTF-8 charset and absent or `identity` content encoding. Raw body limit is 131,072 bytes and the independent Event Core payload limit is 65,536 bytes. If the configured top-level correlation field is present it must be a valid string. Its absence leaves the Event uncorrelated.

| HTTP | Meaning                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------- |
| 202  | Event durably accepted, or durably persisted as unroutable. Agent work proceeds asynchronously.          |
| 200  | The same delivery was already accepted.                                                                  |
| 409  | Delivery ID conflicts with previously accepted content.                                                  |
| 401  | Missing, malformed or incorrect signature.                                                               |
| 400  | Invalid delivery identity, JSON, or event data.                                                          |
| 413  | Raw body or canonical Event payload exceeds its limit.                                                   |
| 415  | Unsupported media type or content encoding.                                                              |
| 503  | Ingress, instance, routing or storage temporarily unavailable. Retry with the same delivery ID and body. |
| 500  | Unexpected intake failure. If retrying an uncertain response, reuse the same identity and body.          |

Authentication establishes possession of the configured key. Payload remains external data and cannot choose the Agent, workspace, capabilities, limits or Automation. The Host supplies instance identity and routing. Keep credentials out of payloads and headers apart from the HMAC signature itself. The configured secret value is rejected if included in payload text or the delivery ID. TaskCircuit intake deduplication does not guarantee exactly-once external effects.
