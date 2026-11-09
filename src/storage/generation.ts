import { DatabaseSync, backup } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  createReadStream,
  openSync,
  closeSync,
  fsyncSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { migrate } from "../migration.js";

export class StorageGenerationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StorageGenerationError";
  }
}
const fail = (code: string, message: string): never => {
  throw new StorageGenerationError(code, message);
};
const quarantineMessage = "taskcircuit_database_upgraded";
const legacyName = "taskcircuit.db";
const currentName = "taskcircuit-gen2.db";
const markerTable = "taskcircuit_storage_cutover";
const generationTable = "taskcircuit_generation";
const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = async (p: string) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(p)) hash.update(chunk);
  return hash.digest("hex");
};
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
const syncFile = (p: string) => {
  const fd = openSync(p, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};
const stage = async (
  fn: ((s: string) => void | Promise<void>) | undefined,
  name: string,
) => {
  if (fn) await fn(name);
};
type Marker = { migration_id: string; backup_sha256: string };
const backupPath = (home: string, id: string) =>
  join(home, `taskcircuit-v1-backup-${id}.sqlite`);
const pendingPath = (home: string, id: string) =>
  join(home, `taskcircuit-gen2-${id}.tmp.db`);
function tableNames(db: DatabaseSync): string[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((x) => String(x.name));
}
function schema(db: DatabaseSync): number {
  return Number(
    db
      .prepare("SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations")
      .get()!.v,
  );
}
function checkIntegrity(db: DatabaseSync) {
  if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
    fail("storage_integrity_failed", "Storage integrity check failed.");
}
function readMarker(db: DatabaseSync): Marker | null {
  if (
    !db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name=?")
      .get(markerTable)
  )
    return null;
  const rows = db
    .prepare(
      `SELECT migration_id,backup_sha256,upgraded_to_generation,target_schema FROM ${markerTable}`,
    )
    .all();
  if (
    rows.length !== 1 ||
    rows[0].upgraded_to_generation !== 2 ||
    rows[0].target_schema !== 5 ||
    typeof rows[0].migration_id !== "string" ||
    !idPattern.test(rows[0].migration_id) ||
    typeof rows[0].backup_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(rows[0].backup_sha256)
  )
    fail("storage_marker_invalid", "Legacy upgrade marker is invalid.");
  const marker = rows[0] as unknown as Marker;
  for (const name of tableNames(db))
    for (const op of ["insert", "update", "delete"]) {
      const trigger = `taskcircuit_quarantine_${name}_${op}`;
      const row = db
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?",
        )
        .get(trigger);
      if (!row || !String(row.sql).includes(quarantineMessage))
        fail(
          "storage_quarantine_invalid",
          "Legacy write quarantine is incomplete.",
        );
    }
  return marker;
}
function validateCurrent(path: string, expectedId: string): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    checkIntegrity(db);
    const version = schema(db);
    if (version > 10)
      fail(
        "database_schema_too_new",
        "Database schema is newer than this TaskCircuit binary supports. Upgrade TaskCircuit before opening this database.",
      );
    if (
      version !== 5 &&
      version !== 6 &&
      version !== 7 &&
      version !== 8 &&
      version !== 9 &&
      version !== 10
    )
      fail(
        "storage_generation_invalid",
        "Generation 2 schema is not a supported version.",
      );
    const v = db
      .prepare(`SELECT migration_id,generation FROM ${generationTable}`)
      .all();
    if (
      v.length !== 1 ||
      v[0].migration_id !== expectedId ||
      v[0].generation !== 2
    )
      fail(
        "storage_generation_invalid",
        "Generation 2 identity does not match legacy marker.",
      );
  } finally {
    db.close();
  }
}
async function createCurrent(
  source: string,
  temp: string,
  id: string,
  onStage?: (stage: string) => void | Promise<void>,
): Promise<void> {
  const reader = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(reader, temp);
  } finally {
    reader.close();
  }
  const db = new DatabaseSync(temp);
  try {
    db.exec("PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE");
    try {
      if (schema(db) !== 4)
        fail(
          "storage_legacy_schema_invalid",
          "Expected legacy schema version 4.",
        );
      db.exec(
        `CREATE TABLE ${generationTable}(migration_id TEXT NOT NULL,generation INTEGER NOT NULL CHECK(generation=2))`,
      );
      await stage(onStage, "generation-transaction-open");
      db.prepare(`INSERT INTO ${generationTable} VALUES(?,2)`).run(id);
      db.prepare(
        "INSERT INTO schema_migrations(version,applied_at) VALUES(5,?)",
      ).run(new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    checkIntegrity(db);
  } finally {
    db.close();
  }
  syncFile(temp);
  validateCurrent(temp, id);
}
function promote(temp: string, current: string): void {
  linkSync(temp, current);
  unlinkSync(temp);
}
export async function resolveCurrentStore(
  home: string,
  options: { onStage?: (stage: string) => void | Promise<void> } = {},
): Promise<string> {
  mkdirSync(home, { recursive: true });
  const legacy = join(home, legacyName),
    current = join(home, currentName);
  const guard = new DatabaseSync(join(home, "taskcircuit-generation-guard.db"));
  let guardLocked = false;
  try {
    guard.exec("PRAGMA busy_timeout=0");
    try {
      guard.exec("BEGIN IMMEDIATE");
      guardLocked = true;
    } catch {
      fail("storage_migration_busy", "Another storage migration is active.");
    }
    if (!existsSync(legacy)) {
      if (existsSync(current))
        fail(
          "storage_marker_missing",
          "Legacy marker is missing; refusing to use Generation 2.",
        );
      const fresh = new DatabaseSync(legacy);
      try {
        fresh.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL");
        migrate(fresh);
      } finally {
        fresh.close();
      }
    }
    const legacyDb = new DatabaseSync(legacy);
    let locked = false;
    try {
      legacyDb.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      locked = true;
      await stage(options.onStage, "barrier-acquired");
      const marker = readMarker(legacyDb);
      if (marker) {
        const bak = backupPath(home, marker.migration_id),
          temp = pendingPath(home, marker.migration_id);
        if (existsSync(current)) {
          validateCurrent(current, marker.migration_id);
          legacyDb.exec("ROLLBACK");
          locked = false;
          return current;
        }
        let candidate = temp;
        let valid = false;
        if (existsSync(candidate)) {
          try {
            validateCurrent(candidate, marker.migration_id);
            valid = true;
          } catch (error) {
            if (
              error instanceof StorageGenerationError &&
              error.code === "database_schema_too_new"
            )
              throw error;
          }
        }
        if (!valid) {
          if (!existsSync(bak) || (await digest(bak)) !== marker.backup_sha256)
            fail(
              "storage_recovery_backup_invalid",
              "Cannot recover Generation 2 from the verified backup.",
            );
          if (existsSync(candidate))
            candidate = join(
              home,
              `taskcircuit-gen2-recovery-${randomUUID()}.tmp.db`,
            );
          await createCurrent(
            bak,
            candidate,
            marker.migration_id,
            options.onStage,
          );
        }
        validateCurrent(candidate, marker.migration_id);
        promote(candidate, current);
        await stage(options.onStage, "generation-promoted");
        legacyDb.exec("ROLLBACK");
        locked = false;
        return current;
      }
      if (existsSync(current))
        fail(
          "storage_marker_missing",
          "Generation 2 exists without legacy quarantine.",
        );
      if (schema(legacyDb) !== 4)
        fail(
          "storage_legacy_schema_invalid",
          "Expected legacy schema version 4.",
        );
      checkIntegrity(legacyDb);
      const active = legacyDb
        .prepare(
          "SELECT COUNT(*) AS n FROM executions WHERE status IN ('running','claimed') OR (status='failed' AND CASE WHEN error IS NULL OR NOT json_valid(error) THEN 1 WHEN json_extract(error,'$.code') IN ('execution_outcome_unknown','agent_timeout') THEN 1 WHEN json_extract(error,'$.retryable') = 1 AND COALESCE(json_extract(error,'$.safeToRetry'),0) <> 1 THEN 1 ELSE 0 END)",
        )
        .get()!;
      const delivery = legacyDb
        .prepare(
          "SELECT COUNT(*) AS n FROM notification_deliveries WHERE status='claimed'",
        )
        .get()!;
      if (Number(active.n) > 0 || Number(delivery.n) > 0)
        fail(
          "storage_legacy_execution_active",
          "Migration blocked: legacy database contains a potentially active execution. Resolve or stop the existing runtime before upgrading.",
        );
      const id = randomUUID(),
        bak = backupPath(home, id),
        temp = pendingPath(home, id);
      const reader = new DatabaseSync(legacy, { readOnly: true });
      try {
        await backup(reader, bak);
      } finally {
        reader.close();
      }
      syncFile(bak);
      const hash = await digest(bak);
      await stage(options.onStage, "backup-created");
      await createCurrent(bak, temp, id, options.onStage);
      await stage(options.onStage, "generation-prepared");
      legacyDb.exec(
        `CREATE TABLE ${markerTable}(migration_id TEXT NOT NULL,upgraded_to_generation INTEGER NOT NULL,target_schema INTEGER NOT NULL,migration_time TEXT NOT NULL,backup_sha256 TEXT NOT NULL)`,
      );
      legacyDb
        .prepare(`INSERT INTO ${markerTable} VALUES(?,2,5,?,?)`)
        .run(id, new Date().toISOString(), hash);
      for (const name of tableNames(legacyDb))
        for (const op of ["insert", "update", "delete"]) {
          const trigger = `taskcircuit_quarantine_${name}_${op}`;
          legacyDb.exec(
            `CREATE TRIGGER ${quote(trigger)} BEFORE ${op.toUpperCase()} ON ${quote(name)} BEGIN SELECT RAISE(ABORT, '${quarantineMessage}'); END`,
          );
        }
      legacyDb.exec("COMMIT");
      locked = false;
      await stage(options.onStage, "legacy-committed");
      promote(temp, current);
      await stage(options.onStage, "generation-promoted");
      return current;
    } finally {
      if (locked) {
        try {
          legacyDb.exec("ROLLBACK");
        } catch {}
      }
      legacyDb.close();
    }
  } finally {
    if (guardLocked) {
      try {
        guard.exec("ROLLBACK");
      } catch {}
    }
    guard.close();
  }
}
