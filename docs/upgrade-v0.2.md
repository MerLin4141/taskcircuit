# Upgrade from v0.1.2 to v0.2.0

**This is a one-way storage generation upgrade.** Stop the v0.1.2 runtime, resolve active or uncertain executions and claimed notification deliveries, and independently back up the complete TaskCircuit home before starting v0.2. Keep that backup outside the working home.

On first open, TaskCircuit locks the legacy `taskcircuit.db`, verifies schema 4 and integrity, and rejects potentially active/uncertain work. It creates a SQLite backup named `taskcircuit-v1-backup-<migration-id>.sqlite` in the same home, flushes it, and records its SHA-256. It builds and validates a temporary Generation 2 copy before committing a quarantine marker and write-blocking triggers to the legacy store. The new store is promoted to `taskcircuit-gen2.db`. The Hub then upgrades it through schema 10.

If backup or validation fails, cutover does not proceed. If interrupted after quarantine, startup validates the pending Generation 2 copy or rebuilds it from the checked same-home backup; invalid or missing recovery data causes startup to fail rather than silently proceed. Preserve all files and investigate errors before retrying. The automatic same-home backup is not a substitute for an independent backup.

The chain is Generation 1 schema 4 → Generation 2 schema 5 → domain schema 6 → event schema 7 → decision schema 8 → feedback schema 9 → loop limits schema 10. A database newer than schema 10 is rejected with `database_schema_too_new`.

Direct downgrade to v0.1.2 is unsupported. Restore your independent pre-upgrade backup to return to v0.1.2; v0.2 changes will not be copied back. No historical Event, Decision, or feedback is invented merely to make old work look like new automation.
