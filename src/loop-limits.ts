import { DatabaseSync } from "node:sqlite";
import { TaskCircuitError } from "./domain.js";
type Row = Record<string, unknown>;
const object = (v: unknown): v is Row =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function loopConfig(snapshot: unknown): {
  maxRuns: number;
  maxDurationSeconds: number;
} {
  if (!object(snapshot))
    throw new TaskCircuitError(
      "loop_config_invalid",
      "自动化循环配置无效",
      400,
    );
  const loop = snapshot.loop === undefined ? {} : snapshot.loop;
  if (!object(loop))
    throw new TaskCircuitError(
      "loop_config_invalid",
      "自动化循环配置无效",
      400,
    );
  const maxRuns = loop.maxRuns === undefined ? 8 : loop.maxRuns,
    maxDurationSeconds =
      loop.maxDurationSeconds === undefined ? 7200 : loop.maxDurationSeconds;
  if (
    !Number.isSafeInteger(maxRuns) ||
    Number(maxRuns) < 1 ||
    Number(maxRuns) > 1000 ||
    !Number.isSafeInteger(maxDurationSeconds) ||
    Number(maxDurationSeconds) < 1 ||
    Number(maxDurationSeconds) > 31536000
  )
    throw new TaskCircuitError(
      "loop_config_invalid",
      "自动化循环配置无效",
      400,
    );
  return {
    maxRuns: Number(maxRuns),
    maxDurationSeconds: Number(maxDurationSeconds),
  };
}
export function frozenLoop(
  snapshot: unknown,
  createdAt: string,
): { maxRuns: number; deadlineAt: string } {
  const config = loopConfig(snapshot),
    start = Date.parse(createdAt);
  if (!Number.isFinite(start)) throw new Error("invalid Root creation time");
  return {
    maxRuns: config.maxRuns,
    deadlineAt: new Date(
      start + config.maxDurationSeconds * 1000,
    ).toISOString(),
  };
}
export function migrateLoopLimits(
  db: DatabaseSync,
  onStage?: (stage: string) => void,
): void {
  if (db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1)
    throw Error("foreign keys required");
  if (
    db.prepare("SELECT generation FROM taskcircuit_generation").get()
      ?.generation !== 2
  )
    throw Error("generation 2 required");
  const version = () =>
    Number(db.prepare("SELECT MAX(version) v FROM schema_migrations").get()?.v);
  if (version() > 10)
    throw new TaskCircuitError(
      "database_schema_too_new",
      "数据库版本过新",
      409,
    );
  if (version() === 10) {
    if (
      !db
        .prepare("PRAGMA table_info(automation_roots)")
        .all()
        .some((x) => x.name === "max_runs")
    )
      throw Error("schema 10 incomplete");
    const columns = db.prepare("PRAGMA table_info(automation_roots)").all();
    if (!columns.some((x) => x.name === "deadline_at"))
      throw Error("schema 10 incomplete");
    for (const name of [
      "root_loop_required",
      "root_loop_immutable",
      "root_mode_immutable",
    ])
      if (
        !db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='trigger' AND name=?",
          )
          .get(name)
      )
        throw Error("schema 10 guard missing");
    const index = db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type='index' AND name='continuation_parent_unique'",
      )
      .get();
    if (
      !index ||
      !String(index.sql).toUpperCase().includes("CREATE UNIQUE INDEX")
    )
      throw Error("schema 10 index missing");
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw Error("schema 10 foreign key check failed");
    return;
  }
  if (version() !== 9) throw Error("schema 9 required");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (version() === 10) {
      db.exec("COMMIT");
      return;
    }
    if (version() !== 9) throw Error("schema 9 required");
    db.exec(
      "ALTER TABLE automation_roots ADD COLUMN max_runs INTEGER; ALTER TABLE automation_roots ADD COLUMN deadline_at TEXT",
    );
    onStage?.("columns-added");
    const roots = db
      .prepare(
        "SELECT r.id,r.created_at,v.config_snapshot_json FROM automation_roots r JOIN automation_definition_versions v ON v.definition_id=r.definition_id AND v.version=r.definition_version WHERE r.mode='automation'",
      )
      .all();
    for (const r of roots) {
      const { maxRuns, deadlineAt } = frozenLoop(
        JSON.parse(String(r.config_snapshot_json)),
        String(r.created_at),
      );
      db.prepare(
        "UPDATE automation_roots SET max_runs=?,deadline_at=? WHERE id=?",
      ).run(maxRuns, deadlineAt, String(r.id));
    }
    onStage?.("roots-populated");
    db.exec(`CREATE TRIGGER root_loop_required BEFORE INSERT ON automation_roots WHEN NEW.mode='automation' AND (NEW.max_runs IS NULL OR NEW.max_runs<1 OR NEW.max_runs>1000 OR NEW.deadline_at IS NULL) BEGIN SELECT RAISE(ABORT,'root_loop_invalid'); END;
 CREATE TRIGGER root_loop_immutable BEFORE UPDATE OF max_runs,deadline_at ON automation_roots WHEN OLD.max_runs IS NOT NEW.max_runs OR OLD.deadline_at IS NOT NEW.deadline_at BEGIN SELECT RAISE(ABORT,'root_loop_immutable'); END;
 CREATE TRIGGER root_mode_immutable BEFORE UPDATE OF mode ON automation_roots WHEN OLD.mode IS NOT NEW.mode BEGIN SELECT RAISE(ABORT,'root_mode_immutable'); END;
 CREATE UNIQUE INDEX continuation_parent_unique ON executions(parent_execution_id) WHERE trigger_kind='continue';`);
    onStage?.("constraints-created");
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw Error("foreign key check failed");
    onStage?.("before-schema-update");
    db.prepare("INSERT INTO schema_migrations VALUES(10,?)").run(
      new Date().toISOString(),
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
