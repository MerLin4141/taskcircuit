# Feishu Channel

TaskCircuit sends plain-text notifications to a Feishu group custom bot. It sends NeedsInput and failure notices, and sends completion notices when the rule sets `notifyOnCompleted: true`. To answer a question, use `taskcircuit inbox` and `taskcircuit answer` on the TaskCircuit machine.

## Configure the bot and Hub

1. In the destination Feishu group, open **Settings → Group bots → Add bot → Custom bot**.
2. In the bot's security settings, enable **Signature verification** and save the change.
3. Copy the webhook URL and signing secret privately. Both are credentials. Give them to the Hub through environment variables. In PowerShell 7, you can enter the values without adding them to the shell command history.

   ```powershell
   $env:TASKCIRCUIT_FEISHU_WEBHOOK_URL = Read-Host 'Feishu webhook URL' -MaskInput
   $env:TASKCIRCUIT_FEISHU_SIGNING_SECRET = Read-Host 'Feishu signing secret' -MaskInput
   ```

4. Merge the following `channels` settings into `taskcircuit.config.json` in the Hub's working directory. Keep the rest of your runtime configuration.

   ```json
   {
     "channels": {
       "local": { "type": "local-console" },
       "team-feishu": {
         "type": "feishu-channel",
         "config": {
           "webhookUrlEnv": "TASKCIRCUIT_FEISHU_WEBHOOK_URL",
           "signingSecretEnv": "TASKCIRCUIT_FEISHU_SIGNING_SECRET",
           "timeoutMs": 5000
         }
       }
     }
   }
   ```

5. Add these properties to the rule in `automations.json`. The rule carries the Channel instance ID. Keep the URL and key out of both JSON files.

   ```json
   {
     "notify": ["team-feishu"],
     "notifyOnCompleted": true
   }
   ```

6. Start `taskcircuit hub` from the configured directory in the shell holding the variables. In a second terminal, run `taskcircuit worker` from the same directory. Apply the rules with `taskcircuit apply automations.json`. If you run the Hub through a background launcher, make the variables available to that launcher's environment before it starts.

See [Feishu's custom bot guide](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot) for the bot setup screens and signature requirements.

The Hub resolves both environment references once at startup. Restart it after rotation. Multiple groups can use separate instance IDs and environment references. The Hub validates HTTPS, the fixed `open.feishu.cn` host and the custom-bot v2 hook path before it becomes ready. Requests disallow redirects. Setup and Doctor perform local checks without sending messages.

## Delivery and troubleshooting

- `taskcircuit doctor` and `taskcircuit doctor --json` show each API 2 instance and its health. `healthy` at startup means configuration passed. A delivery failure changes health to `degraded`, and a later success restores `healthy`. The report omits both credential values.
- Feishu accepts a delivery only when the webhook returns HTTP 2xx and JSON `code: 0`. Verify the current signature key, bot restrictions and Hub clock if delivery fails. The default timeout is 5 seconds. `timeoutMs` accepts integers from 1,000 to 10,000.
- The Hub leases a delivery for 30 seconds, retries failures after 5 seconds and caps attempts at 3. A delivery failure leaves the committed Agent result and any open local interaction intact. A lost success response can cause Feishu to post the same message twice.
- Later and retry waits produce no Feishu notice. The integration sends messages to the group only. Questions stay open in the local Inbox until answered there.
