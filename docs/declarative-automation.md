# Declarative automations

TaskCircuit can apply a rules document explicitly. Before applying, configure the Agent Profile, a Workspace Policy, a matching local Source/type/Agent route and any notification Channel instances in trusted `taskcircuit.config.json`. Start the Hub with that configuration. A rule cannot register these prerequisites or load a plugin module.

For example, after registering Agent Profile `demo-agent`, Workspace Policy `safe`, a `local` / `demo.color` route to that Agent, and Channel instance `local`, save:

```json
{
  "schemaVersion": 1,
  "id": "my-project",
  "rules": [
    {
      "name": "color-helper",
      "when": { "source": "local", "type": "demo.color" },
      "agent": "demo-agent",
      "workspace": "safe",
      "instruction": "处理这个任务",
      "loop": { "maxRuns": 8, "deadline": "2h" },
      "notify": ["local"],
      "notifyOnCompleted": true
    }
  ]
}
```

The document ID and rule names are stable operator-selected identifiers. `workspace` is a Workspace Policy ID, not an arbitrary path. Current Source support is `local`; the trusted route must match the rule's source, type and Agent. Durations use seconds, minutes or hours (`30s`, `15m`, `2h`); defaults are 8 runs and 2 hours.

```powershell
taskcircuit apply .\automations.json --dry-run
taskcircuit apply .\automations.json
taskcircuit apply .\automations.json --json
```

Dry-run validates and plans without database writes. Applying the same effective rule again is unchanged; changing a rule creates a new immutable version. Existing Roots continue using their pinned version. Manual Automations and Automations owned by a different document are not taken over. Conflicts or invalid rules block all writes, and omitting a previously applied rule does not delete or disable it. TaskCircuit does not watch or edit the source file. Only the SQLite mutations are atomic; the file and database are not one transaction.

The endpoint accepts loopback requests under the Trusted Local model. Loopback is **not authentication**; other local processes may be able to access the Hub. Trusted Local and capability metadata are not an OS security sandbox. Do not put plugin module paths, credentials or elevated permissions in rule or Event data.

For a complete runnable setup, see the [v0.3 Quick Start](quickstart-v0.3.md). Existing v0.2 configuration remains valid; using `apply` is optional.
