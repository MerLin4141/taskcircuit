# Architecture and trust boundary

## User-facing model

An Event selects an Automation and starts or correlates with a Root. An Agent produces Complete, Continue, NeedsInput, Later, Failed or Stop feedback. A Root can span multiple Executions; human answers and scheduled work resume the same Agent Session when available.

## Internal runtime

```text
Event → Automation Root → Decision → Work Item → Execution → Worker → Agent
                                                        ↑                │
                                                        └─ Admission ← Feedback
```

Hub persists state in SQLite, checks trusted policy snapshots, materializes decisions, admits work, schedules later/retry, records result receipts and provides a change stream. Before continuation, admission checks Root state, authorization, concurrency, max runs and deadline. Definition versions and decisions are immutable. A receipt confirms Hub commit, not an external action.

Windows Task Scheduler starts the Runtime Launcher, which supervises Hub and Worker using a Job Object. Job Objects manage process lifetime; they do not provide security isolation. Hub listens on loopback by default; loopback is not authentication. Capability metadata is an application authorization decision, not an OS-level filesystem or network sandbox. TaskCircuit uses Trusted Local and cannot guarantee exactly-once external side effects.

See [upgrade](upgrade-v0.2.md), [security model](security-model.md), [Windows runtime](windows-runtime.md), and [API](api.md).
